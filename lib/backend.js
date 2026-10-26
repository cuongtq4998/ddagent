'use strict';
const fs = require('fs');
const path = require('path');
const { run, sleep, retry, lastLines } = require('./util');

const TRANSIENT = /CoreSimulator|timed out|Operation not permitted|service/i;

// ---------------------------------------------------------------- real (Xcode)
function realBackend({ spmDir }) {
  const xcrun = (args, o) => run('xcrun', args, { timeout: 60000, ...o });
  const baseArgs = (ctx, slot) => [
    ctx.projectPath.endsWith('.xcworkspace') ? '-workspace' : '-project', ctx.projectPath,
    '-scheme', ctx.scheme, '-configuration', ctx.config, '-sdk', ctx.sdk,
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', slot.path, '-clonedSourcePackagesDirPath', spmDir,
  ];

  async function productInfo(ctx, slot) {
    const r = await run('xcodebuild', [...baseArgs(ctx, slot), '-showBuildSettings', '-json'], { timeout: 120000 });
    if (r.code) throw new Error(`showBuildSettings failed: ${lastLines(r.out, 4)}`);
    // stderr is merged into out; skip warnings like "[MT] ..." and start at the JSON line
    const arr = JSON.parse(r.out.slice(r.out.search(/^\[\s*$/m)));
    const hit = arr.find((t) => t.buildSettings && t.buildSettings.WRAPPER_EXTENSION === 'app');
    if (!hit) throw new Error('no .app product for this scheme');
    const b = hit.buildSettings;
    return { path: path.join(b.TARGET_BUILD_DIR, b.FULL_PRODUCT_NAME), bundleId: b.PRODUCT_BUNDLE_IDENTIFIER };
  }

  return {
    mock: false,
    async xcodeVersion() {
      const v = await run('xcodebuild', ['-version'], { timeout: 20000 });
      const m = /Build version (\S+)/.exec(v.out);
      if (v.code || !m) throw new Error(`xcodebuild unavailable: ${lastLines(v.out, 2)}`);
      const sdk = await xcrun(['--sdk', 'iphonesimulator', '--show-sdk-version']);
      return `${m[1]}/sdk${sdk.out.trim()}`;
    },
    async list() {
      const r = await xcrun(['simctl', 'list', '-j', 'devices', 'available']);
      if (r.code) throw new Error(lastLines(r.out, 3));
      const out = [];
      for (const [rt, devs] of Object.entries(JSON.parse(r.out).devices)) {
        const m = /\.iOS-(\d+)-(\d+)/.exec(rt);
        if (!m) continue;
        for (const d of devs) out.push({ udid: d.udid, name: d.name, osVersion: `${m[1]}.${m[2]}`, state: d.state, kind: 'simulator' });
      }
      return out;
    },
    resolve(ctx, slot, { onLine }) {
      return run('xcodebuild', [...baseArgs(ctx, slot), '-resolvePackageDependencies'], { onLine, timeout: 600000 })
        .then((r) => { if (r.code) throw new Error(`package resolve failed: ${lastLines(r.out)}`); });
    },
    async build(ctx, slot, { onLine, onSpawn, disableResolve }) {
      const args = [...baseArgs(ctx, slot), ...(disableResolve ? ['-disableAutomaticPackageResolution'] : []), 'build'];
      const r = await run('xcodebuild', args, { onLine, onSpawn, detached: true, timeout: 3600000 });
      if (r.code) throw new Error(`xcodebuild failed (${r.code}): ${lastLines(r.out)}`);
      return productInfo(ctx, slot);
    },
    async boot(udid) {
      const r = await xcrun(['simctl', 'boot', udid]);
      if (r.code && !/current state: Booted/i.test(r.out)) throw new Error(`boot failed: ${lastLines(r.out, 3)}`);
      const s = await xcrun(['simctl', 'bootstatus', udid, '-b'], { timeout: 240000 });
      if (s.code) throw new Error(`bootstatus failed: ${lastLines(s.out, 3)}`);
    },
    install(udid, app) {
      return retry(async () => {
        const r = await xcrun(['simctl', 'install', udid, app], { timeout: 120000 });
        if (r.code) throw new Error(`install failed: ${lastLines(r.out, 3)}`);
      }, { isTransient: (e) => TRANSIENT.test(e.message) });
    },
    async launch(udid, bundleId) {
      const r = await xcrun(['simctl', 'launch', '--terminate-running-process', udid, bundleId], { timeout: 60000 });
      if (r.code) throw new Error(`launch failed: ${lastLines(r.out, 3)}`);
    },
    async doctor({ minFreeGB, root }) {
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });
      const sel = await run('xcode-select', ['-p'], { timeout: 10000 });
      add('xcode-select', sel.code === 0 && !/CommandLineTools/.test(sel.out), sel.out.trim() || 'not set');
      try { add('xcodebuild', true, await this.xcodeVersion()); } catch (e) { add('xcodebuild', false, e.message); }
      const lic = await run('xcodebuild', ['-checkFirstLaunchStatus'], { timeout: 20000 });
      add('first-launch / license', lic.code === 0, lic.code === 0 ? 'ok' : 'run: sudo xcodebuild -runFirstLaunch');
      try {
        const n = (await this.list()).length;
        add('iOS simulators', n > 0, `${n} available`);
      } catch (e) { add('iOS simulators', false, e.message); }
      add('disk free', diskOk(root, minFreeGB), `>= ${minFreeGB} GB`);
      return checks;
    },
  };
}

function diskOk(root, minFreeGB) {
  try {
    const st = fs.statfsSync(root);
    return (st.bavail * st.bsize) / 1e9 >= minFreeGB;
  } catch { return true; }
}

// ---------------------------------------------------------------- mock (no Xcode)
function mockBackend({ speed = 1 } = {}) {
  const ms = (n) => sleep(n * speed);
  const sims = [
    { udid: 'MOCK-IPHONE-16', name: 'iPhone 16', osVersion: '18.0', state: 'Shutdown', kind: 'simulator' },
    { udid: 'MOCK-IPHONE-15', name: 'iPhone 15', osVersion: '17.5', state: 'Shutdown', kind: 'simulator' },
    { udid: 'MOCK-IPAD-PRO', name: 'iPad Pro 11-inch', osVersion: '18.0', state: 'Shutdown', kind: 'simulator' },
    { udid: 'MOCK-IPHONE-15-PRO', name: 'iPhone 15 Pro', osVersion: '17.5', state: 'Shutdown', kind: 'simulator' },
    { udid: 'MOCK-IPAD-AIR', name: 'iPad Air 11-inch', osVersion: '18.0', state: 'Shutdown', kind: 'simulator' },
  ];
  return {
    mock: true,
    async xcodeVersion() { return 'MOCK/sdk18.0'; },
    async list() { return sims.map((s) => ({ ...s })); },
    async resolve() { await ms(300); },
    async build(ctx, slot, { onLine, mode }) {
      const lines = ['Resolve Package Graph', 'CompileSwift normal arm64 ContentView.swift', 'CompileSwift normal arm64 App.swift',
        'Ld App.app/App normal', 'CodeSign App.app', '** BUILD SUCCEEDED **'];
      const total = mode === 'incremental' ? 1200 : 4000;
      for (const l of lines) { onLine(l); await ms(total / lines.length); }
      const app = path.join(slot.path, 'Build', 'Products', 'Debug-iphonesimulator', `${ctx.scheme}.app`);
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'built-at'), String(Date.now()));
      return { path: app, bundleId: `mock.${ctx.scheme}` };
    },
    async boot(udid) {
      const s = sims.find((x) => x.udid === udid);
      await ms(1500);
      s.state = 'Booted';
    },
    async install() { await ms(400); },
    async launch() { await ms(200); },
    async doctor() {
      return ['xcode-select', 'xcodebuild', 'first-launch / license', 'iOS simulators', 'disk free']
        .map((name) => ({ name, ok: true, detail: 'mock' }));
    },
  };
}

module.exports = { realBackend, mockBackend };
