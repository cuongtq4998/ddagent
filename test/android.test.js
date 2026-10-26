'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('../lib/pool');
const { Runner } = require('../lib/runner');
const { Lanes } = require('../lib/lanes');
const { mockBackend } = require('../lib/backend');
const { AndroidRunner } = require('../lib/android-runner');
const android = require('../lib/android');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ddagent-android-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pure parsers
test('android: parses AVD names, adb devices, emulator avd name, Java major, junit counts', () => {
  assert.deepStrictEqual(android.parseAvdList('INFO    | Storing crashdata in: /tmp/x\nMedium_Phone_API_36.1\nPixel-8_API.35\n'), ['Medium_Phone_API_36.1', 'Pixel-8_API.35']);
  assert.deepStrictEqual(android.parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M123\tdevice\n\n'),
    [{ serial: 'emulator-5554', state: 'device' }, { serial: 'emulator-5556', state: 'offline' }]);
  assert.strictEqual(android.parseAvdName('Medium_Phone_API_36.1\nOK\n'), 'Medium_Phone_API_36.1');
  assert.strictEqual(android.parseAvdName('KO: unknown command\n'), null);
  assert.strictEqual(android.parseJavaMajor('openjdk version "17.0.9" 2023-10-17'), 17);
  assert.strictEqual(android.parseJavaMajor('java version "1.8.0_391"'), 8);
  assert.strictEqual(android.parseJavaMajor('openjdk version "21" 2023-09-19'), 21);
  assert.strictEqual(android.parseJavaMajor('Unable to locate a Java Runtime.'), null);
  const xml = '<?xml version="1.0"?><testsuite name="a" tests="5" skipped="1" failures="2" errors="1" time="1">';
  assert.deepStrictEqual(android.summarizeJunit([xml, xml]), { tests: 10, failures: 4, errors: 2, skipped: 2, files: 2 });
});

test('android: emulator port skips used serials and ports claimed by an in-flight boot', () => {
  assert.strictEqual(android.pickEmulatorPort([], new Set()), 5554);
  assert.strictEqual(android.pickEmulatorPort([{ serial: 'emulator-5554' }], new Set([5556])), 5558);
  const all = Array.from({ length: 16 }, (_, i) => ({ serial: `emulator-${5554 + i * 2}` }));
  assert.strictEqual(android.pickEmulatorPort(all, new Set()), null);
});

test('android: sdk root honours ANDROID_HOME, then the default location', () => {
  const sdk = tmp();
  assert.strictEqual(android.sdkRoot({ ANDROID_HOME: sdk }, '/nonexistent', 'darwin'), sdk);
  const home = tmp();
  const def = path.join(home, 'Library', 'Android', 'sdk');
  fs.mkdirSync(def, { recursive: true });
  assert.strictEqual(android.sdkRoot({}, home, 'darwin'), def);
  assert.strictEqual(android.sdkRoot({}, tmp(), 'darwin'), null);
});

test('android: only JUnit files written by this run are collected', () => {
  const mod = tmp();
  const dir = path.join(mod, 'build', 'outputs', 'androidTest-results', 'connected', 'pixel');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'TEST-old.xml');
  const fresh = path.join(dir, 'TEST-new.xml');
  fs.writeFileSync(old, '<testsuite tests="9" failures="9" errors="0" skipped="0">');
  fs.writeFileSync(fresh, '<testsuite tests="2" failures="0" errors="0" skipped="0">');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(old, past, past);
  const files = android.newJunitFiles(mod, Date.now() - 1000);
  assert.deepStrictEqual(files, [fresh]);
  const out = tmp();
  const sum = android.copyJunit(mod, files, out);
  assert.strictEqual(sum.tests, 2);
  assert.ok(fs.readdirSync(path.join(out, 'junit'))[0].startsWith('build__outputs__'));
});

test('android: artifact pruning keeps only the newest job folders', () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) {
    const d = path.join(root, 'lane', `job${i}`);
    fs.mkdirSync(d, { recursive: true });
    const t = new Date(Date.now() - (5 - i) * 10000);
    fs.utimesSync(d, t, t);
  }
  android.pruneArtifacts(root, 2);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'lane')).sort(), ['job3', 'job4']);
});

test('android: request validation rejects relative paths, odd modules and non-whitelisted tasks', () => {
  const dir = tmp();
  const ok = { project: dir, module: 'app', task: 'assembleDebug' };
  assert.doesNotThrow(() => android.validateRequest(ok));
  assert.throws(() => android.validateRequest({ ...ok, project: 'rel/dir' }), /absolute/);
  assert.throws(() => android.validateRequest({ ...ok, project: path.join(dir, 'missing') }), /absolute/);
  assert.throws(() => android.validateRequest({ ...ok, module: 'app; rm -rf /' }), /module/);
  assert.throws(() => android.validateRequest({ ...ok, task: 'clean' }), /task must be one of/);
});

// ---------------------------------------------------------------- lanes
const MIXED = [
  { udid: 'U-A', name: 'Sim A', state: 'Shutdown', kind: 'simulator' },
  { udid: 'avd:Pixel_8', name: 'Pixel_8', state: 'Shutdown', kind: 'emulator', platform: 'android' },
  { udid: 'avd:Pixel_Tablet', name: 'Pixel_Tablet', state: 'Booted', kind: 'emulator', platform: 'android' },
];

test('lanes: platform selects the device kind; default stays iOS; cap and queue are shared', async () => {
  const lanes = new Lanes({ max: 2, sims: () => MIXED });
  const ios = await lanes.acquire({ owner: 'a' }).promise;
  assert.strictEqual(ios.udid, 'U-A');
  assert.strictEqual(ios.platform, 'ios');
  const droid = await lanes.acquire({ owner: 'a', platform: 'android' }).promise;
  assert.strictEqual(droid.udid, 'avd:Pixel_Tablet', 'prefers the already booted AVD');
  assert.notStrictEqual(droid.id, ios.id, 'same owner holds one lane per platform');
  const third = lanes.acquire({ owner: 'b', platform: 'android' });
  const queued = await Promise.race([third.promise.then(() => 'granted'), sleep(20).then(() => 'waiting')]);
  assert.strictEqual(queued, 'waiting', 'android waits behind the shared cap of 2');
  assert.strictEqual(lanes.snapshot().waiting[0].platform, 'android');
  lanes.release(ios.id);
  assert.strictEqual((await third.promise).udid, 'avd:Pixel_8');
});

test('lanes: Android target filter and rejection; the iOS filter never matches an AVD', async () => {
  const lanes = new Lanes({ max: 4, sims: () => MIXED });
  assert.strictEqual((await lanes.acquire({ owner: 'a', platform: 'android', want: 'pixel_8' }).promise).udid, 'avd:Pixel_8');
  await assert.rejects(lanes.acquire({ owner: 'b', platform: 'android', want: 'nope' }).promise, /no android device matches: nope/);
  await assert.rejects(lanes.acquire({ owner: 'c', want: 'Pixel_8' }).promise, /no simulator matches/);
  await assert.rejects(new Lanes({ sims: () => [] }).acquire({ owner: 'd', platform: 'android' }).promise, /no android device available/);
});

test('lanes: release emits the lane so the daemon can stop its emulator', async () => {
  const lanes = new Lanes({ max: 4, sims: () => MIXED });
  const seen = [];
  lanes.on('released', (l) => seen.push(l.udid));
  const l = await lanes.acquire({ owner: 'a', platform: 'android' }).promise;
  lanes.release(l.id);
  assert.deepStrictEqual(seen, [l.udid]);
});

// ---------------------------------------------------------------- AndroidRunner on the mock backend
function makeAndroid({ failOn, android: custom } = {}) {
  const pool = new Pool({ root: path.join(tmp(), 'pool'), max: 1 });
  pool.init();
  const backend = mockBackend({ speed: 0.01 });
  const runner = new Runner({ pool, backend });
  const home = tmp();
  const { mockAndroid } = android;
  const droid = custom || mockAndroid({ speed: 0.01, failOn });
  const ar = new AndroidRunner({ runner, android: droid, home, minFreeGB: 0 });
  const lanes = new Lanes({ max: 4, sims: () => [] });
  return { runner, ar, home, droid, lane: (name, id = name) => ({ id, udid: `avd:${name}`, name, platform: 'android' }), lanes };
}

const finish = (runner, job) => new Promise((res) => {
  const check = () => { if (job.endedAt) { runner.off('change', check); res(job); } };
  runner.on('change', check); check();
});

function projectDir() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.gradle.kts'), '');
  return dir;
}

test('android runner: instrumented test run boots the AVD, runs Gradle and collects evidence', async () => {
  const { runner, ar, lane } = makeAndroid();
  const l = lane('Mock_Pixel_8_API_35', 'L1');
  const j1 = await finish(runner, ar.submit({ project: projectDir(), module: 'app', task: 'connectedDebugAndroidTest', lane: l }));
  assert.strictEqual(j1.status, 'done');
  assert.strictEqual(j1.mode, 'android-test');
  assert.deepStrictEqual(j1.targets[0].phases.map((p) => `${p.name}:${p.status}`), ['booting:done', 'building:done', 'collecting:done']);
  assert.strictEqual(j1.tests.tests, 3);
  for (const f of ['logcat.txt', 'screenshot-final.png', path.join('junit', 'TEST-mock.SmokeTest.xml')]) assert.ok(fs.existsSync(path.join(j1.artifacts, f)), f);
  assert.ok(j1.artifacts.includes(path.join('artifacts', 'L1')), 'artifacts live under the lane folder');
  assert.ok(!runner.busy.has(l.udid), 'busy flag cleared');
  const j2 = await finish(runner, ar.submit({ project: projectDir(), module: 'app', task: 'assembleDebug', lane: l }));
  assert.strictEqual(j2.targets[0].phases[0].status, 'skipped', 'emulator already running');
});

test('android runner: a failing Gradle run still collects artifacts and reports failure', async () => {
  const { runner, ar, lane } = makeAndroid({ failOn: 'gradle' });
  const l = lane('Mock_Pixel_8_API_35');
  const j = await finish(runner, ar.submit({ project: projectDir(), module: 'app', task: 'assembleDebug', lane: l }));
  assert.strictEqual(j.status, 'failed');
  assert.match(j.error, /gradle assembleDebug failed/);
  assert.ok(fs.existsSync(path.join(j.artifacts, 'logcat.txt')), 'evidence collected after a failure');
  assert.ok(!runner.busy.has(l.udid));
});

test('android runner: a boot failure fails the job without running Gradle and frees the AVD', async () => {
  const { runner, ar, lane } = makeAndroid({ failOn: 'boot' });
  const l = lane('Mock_Pixel_8_API_35');
  const j = await finish(runner, ar.submit({ project: projectDir(), module: 'app', task: 'assembleDebug', lane: l }));
  assert.strictEqual(j.status, 'failed');
  assert.match(j.error, /did not finish booting/);
  assert.deepStrictEqual(j.targets[0].phases.map((p) => p.name), ['booting']);
  assert.ok(!runner.busy.has(l.udid));
});

test('android runner: rejects unsafe requests before creating a job', () => {
  const { runner, ar, lane } = makeAndroid();
  assert.throws(() => ar.submit({ project: projectDir(), module: 'app', task: 'clean', lane: lane('X') }), /task/);
  assert.throws(() => ar.submit({ project: 'rel', module: 'app', task: 'assembleDebug', lane: lane('X') }), /absolute/);
  assert.strictEqual(runner.jobs.size, 0);
  assert.strictEqual(runner.busy.size, 0);
});

test('android runner: two lanes on one project directory run Gradle one after the other', async () => {
  const { mockAndroid } = android;
  const inner = mockAndroid({ speed: 0.01 });
  let active = 0;
  let overlap = false;
  const watched = {
    ...inner,
    ensureBooted: (...a) => inner.ensureBooted(...a),
    async gradle(opts) {
      active++; overlap = overlap || active > 1;
      try { return await inner.gradle(opts); } finally { active--; }
    },
  };
  const { runner, ar, lane } = makeAndroid({ android: watched });
  const project = projectDir();
  const jobs = await Promise.all([
    finish(runner, ar.submit({ project, module: 'app', task: 'assembleDebug', lane: lane('Mock_Pixel_8_API_35', 'L1') })),
    finish(runner, ar.submit({ project, module: 'app', task: 'assembleDebug', lane: lane('Mock_Pixel_Tablet_API_35', 'L2') })),
  ]);
  assert.deepStrictEqual(jobs.map((j) => j.status), ['done', 'done']);
  assert.strictEqual(overlap, false);
});

test('android mock: shutdown only stops an emulator ddagent booted', async () => {
  const m = android.mockAndroid({ speed: 0.01 });
  await m.ensureBooted('Mock_Pixel_8_API_35');
  assert.strictEqual((await m.list()).find((a) => a.name === 'Mock_Pixel_8_API_35').state, 'Booted');
  assert.strictEqual(await m.shutdown('Mock_Pixel_8_API_35'), true);
  assert.strictEqual(await m.shutdown('Mock_Pixel_8_API_35'), false);
  assert.strictEqual((await m.list()).find((a) => a.name === 'Mock_Pixel_8_API_35').state, 'Shutdown');
});

// ---------------------------------------------------------------- CLI + daemon, mock mode
test('cli: Android lane acquire, run, list, doctor and release against a mock daemon', () => {
  const home = tmp();
  const port = 17813;
  const project = projectDir();
  const cli = path.join(__dirname, '..', 'bin', 'ddagent');
  const env = { ...process.env, DDAGENT_HOME: home, DDAGENT_PORT: String(port), DDAGENT_MOCK: '1', DDAGENT_MOCK_SPEED: '0.05', DDAGENT_NO_OPEN: '1' };
  const ddagent = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  try {
    const acquired = ddagent('lane', 'acquire', '--platform', 'android', '--owner', 'tester');
    assert.strictEqual(acquired.status, 0, acquired.stderr);
    const lane = acquired.stdout.trim();
    assert.match(lane, /^[0-9a-f]{8}$/);
    const ran = ddagent('run', '--lane', lane, '--project', project, '--module', 'app', '--task', 'connectedDebugAndroidTest');
    assert.strictEqual(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /DONE\s+mode=android-test.*tests=3 failures=0/);
    const dir = /artifacts: (.+)/.exec(ran.stdout)[1];
    assert.ok(fs.existsSync(path.join(dir, 'logcat.txt')));
    const listed = ddagent('lane', 'list');
    assert.match(listed.stdout, new RegExp(`${lane}\\s+android\\s+owner=tester`));
    assert.match(ddagent('status').stdout, /Mock_Pixel_8_API_35\s+android\s+Booted/);
    const doc = ddagent('doctor', '--platform', 'android');
    assert.strictEqual(doc.status, 0);
    assert.match(doc.stdout, /JDK 17\+/);
    assert.doesNotMatch(doc.stdout, /xcodebuild/);
    const badProject = ddagent('run', '--lane', lane, '--project', '/nonexistent/App.xcodeproj');
    assert.notStrictEqual(badProject.status, 0);
    assert.match(badProject.stderr, /Android project directory/, 'an Android lane routes to the Android runner, not xcodebuild');
    assert.strictEqual(ddagent('lane', 'release', lane).status, 0);
    let state = '';
    for (let i = 0; i < 40 && !/Mock_Pixel_8_API_35\s+android\s+Shutdown/.test(state); i++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); state = ddagent('status').stdout; }
    assert.match(state, /Mock_Pixel_8_API_35\s+android\s+Shutdown/, 'releasing the lane stops the emulator ddagent booted');
    const bad = ddagent('lane', 'acquire', '--platform', 'android', '--target', 'nope');
    assert.notStrictEqual(bad.status, 0);
    assert.match(bad.stderr, /no android device matches: nope/);
  } finally {
    try { process.kill(JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')).pid); } catch { /* already gone */ }
  }
});
