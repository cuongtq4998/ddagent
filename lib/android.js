'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, sleep, killTree, lastLines } = require('./util');

// Android backend: AVD discovery, headless emulator lifecycle, Gradle runs, artifact collection.
// Same contract in realAndroid and mockAndroid (see CLAUDE.md): list, ensureBooted, shutdown, shutdownAll,
// prepareDevice, gradle, collect, doctor.

const AVD_PREFIX = 'avd:';                    // target id = avd:<name>, never clashes with an iOS UDID
const AVD_NAME = /^[A-Za-z0-9_.\-]+$/;
const EMULATOR_PORTS = { first: 5554, last: 5584 }; // adb scans consecutive even/odd pairs in this range
const MIN_JDK_MAJOR = 17;
const DEVICE_SCREENSHOT_DIR = '/sdcard/Pictures/ddagent'; // tests may write screenshots here; they are pulled after the run
const FINAL_SCREENSHOT_REMOTE = '/sdcard/ddagent-final.png';
const BOOT_POLL_MS = 2000;
const GRADLE_TIMEOUT_MS = 60 * 60 * 1000;
const JUNIT_DIRS = [path.join('build', 'outputs', 'androidTest-results', 'connected'), path.join('build', 'test-results')];
const TASKS = Object.freeze(['assembleDebug', 'connectedDebugAndroidTest']);
const MODULE_NAME = /^[A-Za-z0-9_\-]+$/;

const avdTargetId = (name) => `${AVD_PREFIX}${name}`;
const avdNameOf = (udid) => String(udid).slice(AVD_PREFIX.length);

// ---------------------------------------------------------------- pure helpers (unit tested)
function parseAvdList(out) {
  return String(out).split('\n').map((l) => l.trim()).filter((l) => AVD_NAME.test(l));
}

// "emulator-5554\tdevice" -> [{ serial, state }]
function parseAdbDevices(out) {
  return String(out).split('\n').slice(1).map((l) => l.trim().split(/\s+/))
    .filter((p) => /^emulator-\d+$/.test(p[0]) && p[1]).map((p) => ({ serial: p[0], state: p[1] }));
}

// First line of `adb -s <serial> emu avd name`; the second line is "OK".
function parseAvdName(out) {
  const first = String(out).split('\n')[0].trim();
  return AVD_NAME.test(first) ? first : null;
}

function parseJavaMajor(out) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(String(out));
  if (!m) return null;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]); // "1.8.0" is Java 8
}

function pickEmulatorPort(usedDevices, claimed) {
  const used = new Set([...usedDevices.map((d) => Number(d.serial.slice('emulator-'.length))), ...claimed]);
  for (let p = EMULATOR_PORTS.first; p <= EMULATOR_PORTS.last; p += 2) if (!used.has(p)) return p;
  return null;
}

function parseJunitCounts(xml) {
  const m = /<testsuite\b[^>]*>/.exec(xml);
  if (!m) return { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const attr = (n) => Number((new RegExp(`\\b${n}="(\\d+)"`).exec(m[0]) || [])[1] || 0);
  return { tests: attr('tests'), failures: attr('failures'), errors: attr('errors'), skipped: attr('skipped') };
}

function summarizeJunit(xmls) {
  const sum = { tests: 0, failures: 0, errors: 0, skipped: 0, files: xmls.length };
  for (const x of xmls) { const c = parseJunitCounts(x); for (const k of Object.keys(c)) sum[k] += c[k]; }
  return sum;
}

function validateRequest({ project, module, task }) {
  if (!project || !path.isAbsolute(project) || !fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new Error('project must be an existing absolute Android project directory');
  if (!MODULE_NAME.test(module || '')) throw new Error('invalid module');
  if (!TASKS.includes(task)) throw new Error(`task must be one of: ${TASKS.join(', ')}`);
}

function findFiles(dir, ext, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, ext, out); else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// JUnit XML written by this run only (older files in build/ belong to earlier runs).
function newJunitFiles(moduleDir, since) {
  return JUNIT_DIRS.flatMap((d) => findFiles(path.join(moduleDir, d), '.xml'))
    .filter((f) => fs.statSync(f).mtimeMs >= since - 1000);
}

function copyJunit(moduleDir, files, artifactsDir) {
  const dest = path.join(artifactsDir, 'junit');
  fs.mkdirSync(dest, { recursive: true });
  const xmls = [];
  for (const f of files) {
    fs.copyFileSync(f, path.join(dest, path.relative(moduleDir, f).split(path.sep).join('__')));
    xmls.push(fs.readFileSync(f, 'utf8'));
  }
  return summarizeJunit(xmls);
}

// Keep the newest `keep` job folders under <root>/<lane>/<job>.
function pruneArtifacts(root, keep = 20) {
  const jobs = [];
  try {
    for (const lane of fs.readdirSync(root)) {
      for (const job of fs.readdirSync(path.join(root, lane))) {
        const p = path.join(root, lane, job);
        jobs.push({ p, at: fs.statSync(p).mtimeMs });
      }
    }
  } catch { return; }
  jobs.sort((a, b) => b.at - a.at).slice(keep).forEach((j) => fs.rmSync(j.p, { recursive: true, force: true }));
}

function diskFreeOk(dir, minFreeGB) {
  try {
    const st = fs.statfsSync(dir);
    return (st.bavail * st.bsize) / 1e9 >= minFreeGB;
  } catch { return true; }
}

// ---------------------------------------------------------------- real (Android SDK + Gradle)
function sdkRoot(env = process.env, home = os.homedir(), platform = process.platform) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
    platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : path.join(home, 'Android', 'Sdk')].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function realAndroid({ home, bootTimeoutMs = 300000 }) {
  const sdk = sdkRoot();
  const tool = (rel, fallback) => { const p = sdk && path.join(sdk, rel); return p && fs.existsSync(p) ? p : fallback; };
  const adbBin = tool(path.join('platform-tools', 'adb'), 'adb');
  const emulatorBin = tool(path.join('emulator', 'emulator'), 'emulator');
  const adb = (args, o) => run(adbBin, args, { timeout: 30000, ...o });
  const started = new Map();   // avd name -> { child, serial, port }: emulators ddagent booted (and may kill)
  const claimedPorts = new Set();
  const logDir = path.join(home, 'android');

  async function resolveJdk() {
    const homes = [process.env.JAVA_HOME];
    if (process.platform === 'darwin') {
      const r = await run('/usr/libexec/java_home', ['-v', String(MIN_JDK_MAJOR)], { timeout: 10000 });
      if (r.code === 0) homes.push(r.out.trim());
    }
    let first = null;
    for (const h of homes.filter(Boolean)) {
      const v = await run(path.join(h, 'bin', 'java'), ['-version'], { timeout: 15000 });
      const major = parseJavaMajor(v.out);
      if (major == null) continue;
      const found = { home: h, major };
      if (major >= MIN_JDK_MAJOR) return found;
      first = first || found;
    }
    if (process.platform !== 'darwin') { // on macOS a bare `java` is an installer stub, so it is never probed
      const v = await run('java', ['-version'], { timeout: 15000 });
      const major = parseJavaMajor(v.out);
      if (major != null) return major >= MIN_JDK_MAJOR || !first ? { home: null, major } : first;
    }
    return first;
  }

  async function runningEmulators() {
    const r = await adb(['devices']);
    if (r.code) return [];
    const out = [];
    for (const d of parseAdbDevices(r.out)) {
      const n = await adb(['-s', d.serial, 'emu', 'avd', 'name'], { timeout: 10000 });
      out.push({ ...d, avd: n.code === 0 ? parseAvdName(n.out) : null });
    }
    return out;
  }

  async function waitBootCompleted(serial, { child, timeoutMs, onLine }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (child && child.exitCode != null) throw new Error(`emulator exited early (code ${child.exitCode}); see ${path.join(logDir, 'emulator-*.log')}`);
      const r = await adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 });
      if (r.code === 0 && r.out.trim() === '1') return;
      if (Date.now() > deadline) throw new Error(`emulator ${serial} did not finish booting within ${Math.round(timeoutMs / 1000)}s`);
      if (onLine) onLine(`waiting for ${serial} to boot...`);
      await sleep(BOOT_POLL_MS);
    }
  }

  async function stopStarted(name) {
    const e = started.get(name);
    if (!e) return false;
    started.delete(name);
    await adb(['-s', e.serial, 'emu', 'kill'], { timeout: 15000 });
    for (let i = 0; i < 20 && e.child.exitCode == null; i++) await sleep(500);
    if (e.child.exitCode == null) killTree(e.child, true);
    claimedPorts.delete(e.port);
    return true;
  }

  async function bootNew(name, { timeoutMs, onLine }) {
    const used = await runningEmulators();
    const port = pickEmulatorPort(used, claimedPorts); // claimed synchronously, so two boots never take one port
    if (port == null) throw new Error('no free emulator port');
    claimedPorts.add(port);
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, `emulator-${name}.log`), 'w');
    const args = emulatorArgs(name, port, process.env);
    const child = spawn(emulatorBin, args, { detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    const serial = `emulator-${port}`;
    const entry = { child, serial, port };
    started.set(name, entry);
    child.on('error', () => {});
    child.on('exit', () => { claimedPorts.delete(port); if (started.get(name) === entry) started.delete(name); });
    if (onLine) onLine(`booting ${name} as ${serial}`);
    try {
      await waitBootCompleted(serial, { child, timeoutMs, onLine });
    } catch (e) {
      if (started.get(name) === entry) await stopStarted(name); else killTree(child, true);
      throw e;
    }
    return { serial, started: true };
  }

  return {
    mock: false,
    sdk,
    async list() {
      const r = await run(emulatorBin, ['-list-avds'], { timeout: 30000 });
      if (r.code) throw new Error(`emulator -list-avds failed: ${lastLines(r.out, 3)}`);
      const live = await runningEmulators();
      return parseAvdList(r.out).map((name) => ({
        udid: avdTargetId(name), name, osVersion: '', kind: 'emulator', platform: 'android',
        state: live.some((d) => d.avd === name && d.state === 'device') ? 'Booted' : 'Shutdown',
      }));
    },
    // Returns { serial, started }. Reuses a running emulator (never killed unless ddagent started it).
    async ensureBooted(name, { onLine, timeoutMs = bootTimeoutMs } = {}) {
      const live = (await runningEmulators()).find((d) => d.avd === name);
      if (live) { await waitBootCompleted(live.serial, { timeoutMs, onLine }); return { serial: live.serial, started: false }; }
      return bootNew(name, { timeoutMs, onLine });
    },
    shutdown: stopStarted,
    async shutdownAll() { await Promise.all([...started.keys()].map(stopStarted)); },
    async prepareDevice(serial) {
      await adb(['-s', serial, 'logcat', '-c']);
      await adb(['-s', serial, 'shell', 'rm', '-rf', DEVICE_SCREENSHOT_DIR]);
    },
    // Resolves { code, out } and never throws for a failing build; throws only when Gradle cannot start.
    async gradle({ project, module, task, serial, projectCacheDir, onLine, onSpawn }) {
      const wrapper = path.join(project, 'gradlew');
      if (!fs.existsSync(wrapper)) throw new Error(`no gradlew in ${project}; ddagent only runs the project's Gradle wrapper`);
      const jdk = await resolveJdk();
      if (!jdk || jdk.major < MIN_JDK_MAJOR) throw new Error(`JDK ${MIN_JDK_MAJOR}+ not found (set JAVA_HOME); run ddagent doctor`);
      if (!sdk) throw new Error('Android SDK not found (set ANDROID_HOME); run ddagent doctor');
      fs.mkdirSync(projectCacheDir, { recursive: true });
      const env = {
        ...process.env, ANDROID_HOME: sdk, ANDROID_SERIAL: serial,
        ...(jdk.home ? { JAVA_HOME: jdk.home } : {}),
        ...(process.env.DDAGENT_GRADLE_USER_HOME ? { GRADLE_USER_HOME: process.env.DDAGENT_GRADLE_USER_HOME } : {}),
      };
      const args = [`:${module}:${task}`, '--project-cache-dir', projectCacheDir, '--console=plain'];
      return run(wrapper, args, { cwd: project, env, onLine, onSpawn, detached: true, timeout: GRADLE_TIMEOUT_MS });
    },
    // JUnit XML, logcat, final screenshot and test-written screenshots -> artifactsDir. Returns the JUnit summary.
    async collect({ project, module, serial, artifactsDir, since }) {
      fs.mkdirSync(artifactsDir, { recursive: true });
      const moduleDir = path.join(project, module);
      const summary = copyJunit(moduleDir, newJunitFiles(moduleDir, since), artifactsDir);
      const log = await adb(['-s', serial, 'logcat', '-d', '-v', 'threadtime'], { timeout: 60000 });
      fs.writeFileSync(path.join(artifactsDir, 'logcat.txt'), log.out);
      const shot = await adb(['-s', serial, 'shell', 'screencap', '-p', FINAL_SCREENSHOT_REMOTE]);
      if (shot.code === 0) {
        await adb(['-s', serial, 'pull', FINAL_SCREENSHOT_REMOTE, path.join(artifactsDir, 'screenshot-final.png')], { timeout: 60000 });
        await adb(['-s', serial, 'shell', 'rm', '-f', FINAL_SCREENSHOT_REMOTE]);
      }
      const shots = path.join(artifactsDir, 'device-screenshots');
      fs.mkdirSync(shots, { recursive: true });
      await adb(['-s', serial, 'pull', `${DEVICE_SCREENSHOT_DIR}/.`, shots], { timeout: 120000 }); // missing dir is fine
      return summary;
    },
    async doctor({ minFreeGB, root }) {
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });
      const jdk = await resolveJdk();
      add(`JDK ${MIN_JDK_MAJOR}+`, !!jdk && jdk.major >= MIN_JDK_MAJOR, jdk ? `Java ${jdk.major}${jdk.home ? ` at ${jdk.home}` : ''}` : 'not found: install a JDK 17 or set JAVA_HOME');
      add('Android SDK', !!sdk, sdk || 'not found: set ANDROID_HOME (default location checked: ~/Library/Android/sdk on macOS, ~/Android/Sdk elsewhere)');
      const v = await run(adbBin, ['version'], { timeout: 15000 });
      add('adb', v.code === 0, v.code === 0 ? (/Version (\S+)/.exec(v.out) || [, 'ok'])[1] : 'not found: install platform-tools');
      const e = await run(emulatorBin, ['-version'], { timeout: 15000 });
      add('emulator', e.code === 0, e.code === 0 ? (/version (\S+)/.exec(e.out) || [, 'ok'])[1] : 'not found: install the Android Emulator package');
      try {
        const n = e.code === 0 ? parseAvdList((await run(emulatorBin, ['-list-avds'], { timeout: 30000 })).out).length : 0;
        add('Android AVDs', n > 0, `${n} available (ddagent never creates AVDs)`);
      } catch (err) { add('Android AVDs', false, err.message); }
      add('disk free (android)', diskFreeOk(root, minFreeGB), `>= ${minFreeGB} GB`);
      return checks;
    },
  };
}

// ---------------------------------------------------------------- mock (no emulator, no Gradle)
function mockAndroid({ speed = 1, failOn = null } = {}) {
  const ms = (n) => sleep(n * speed);
  const avds = [
    { udid: avdTargetId('Mock_Pixel_8_API_35'), name: 'Mock_Pixel_8_API_35', osVersion: '', state: 'Shutdown', kind: 'emulator', platform: 'android' },
    { udid: avdTargetId('Mock_Pixel_Tablet_API_35'), name: 'Mock_Pixel_Tablet_API_35', osVersion: '', state: 'Shutdown', kind: 'emulator', platform: 'android' },
  ];
  const byName = (n) => avds.find((a) => a.name === n);
  const ours = new Set();
  return {
    mock: true,
    sdk: '/mock/android-sdk',
    async list() { return avds.map((a) => ({ ...a })); },
    async ensureBooted(name, { onLine } = {}) {
      const a = byName(name);
      if (!a) throw new Error(`no such AVD: ${name}`);
      if (a.state === 'Booted') return { serial: 'emulator-5554', started: false };
      if (onLine) onLine(`booting ${name}`);
      await ms(1500);
      if (failOn === 'boot') throw new Error(`emulator emulator-5554 did not finish booting within ${Math.round(300)}s`);
      a.state = 'Booted';
      ours.add(name);
      return { serial: 'emulator-5554', started: true };
    },
    async shutdown(name) {
      if (!ours.delete(name)) return false;
      byName(name).state = 'Shutdown';
      return true;
    },
    async shutdownAll() { await Promise.all([...ours].map((n) => this.shutdown(n))); },
    async prepareDevice() { await ms(50); },
    async gradle({ module, task, onLine }) {
      const lines = [`> Task :${module}:preBuild`, `> Task :${module}:compileDebugKotlin`, `> Task :${module}:${task}`];
      for (const l of lines) { onLine(l); await ms(400); }
      if (failOn === 'gradle') { onLine('FAILURE: Build failed with an exception.'); return { code: 1, out: 'FAILURE' }; }
      onLine('BUILD SUCCESSFUL');
      return { code: 0, out: 'BUILD SUCCESSFUL' };
    },
    async collect({ task, artifactsDir }) {
      fs.mkdirSync(path.join(artifactsDir, 'junit'), { recursive: true });
      const testing = task === 'connectedDebugAndroidTest';
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="mock.SmokeTest" tests="${testing ? 3 : 0}" failures="0" errors="0" skipped="0"></testsuite>\n`;
      fs.writeFileSync(path.join(artifactsDir, 'junit', 'TEST-mock.SmokeTest.xml'), xml);
      fs.writeFileSync(path.join(artifactsDir, 'logcat.txt'), 'mock logcat\n');
      fs.writeFileSync(path.join(artifactsDir, 'screenshot-final.png'), 'mock png');
      return summarizeJunit([xml]);
    },
    async doctor() {
      return ['JDK 17+', 'Android SDK', 'adb', 'emulator', 'Android AVDs', 'disk free (android)']
        .map((name) => ({ name, ok: true, detail: 'mock' }));
    },
  };
}

// Headless by default (agents run in parallel and need no screen). DDAGENT_ANDROID_WINDOW=1 shows the emulator window
// so a person can watch the run; the window needs a logged-in macOS or desktop session.
function emulatorArgs(name, port, env) {
  const showWindow = /^(1|true|yes)$/i.test(String(env.DDAGENT_ANDROID_WINDOW || ''));
  const args = ['-avd', name, '-port', String(port)];
  if (!showWindow) args.push('-no-window');
  args.push('-no-snapshot-save', '-no-boot-anim', '-no-audio');
  return args;
}

module.exports = {
  realAndroid, mockAndroid, sdkRoot, avdTargetId, avdNameOf, TASKS, MODULE_NAME, validateRequest, pruneArtifacts, diskFreeOk,
  emulatorArgs, parseAvdList, parseAdbDevices, parseAvdName, parseJavaMajor, pickEmulatorPort, parseJunitCounts, summarizeJunit, newJunitFiles, copyJunit,
};
