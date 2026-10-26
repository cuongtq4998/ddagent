'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('../lib/pool');
const { Runner } = require('../lib/runner');
const { mockBackend } = require('../lib/backend');
const { computeKey } = require('../lib/fingerprint');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ddagent-'));
const ctxOf = (o = {}) => ({ projectPath: '/p/a.xcodeproj', scheme: 'a', config: 'Debug', sdk: 'iphonesimulator', arch: 'arm64', xcode: 'x', ...o });

function makeProject() {
  const dir = tmp();
  const proj = path.join(dir, 'a.xcodeproj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'project.pbxproj'), 'pbx');
  fs.writeFileSync(path.join(dir, 'App.swift'), 'let a = 1');
  return { dir, proj };
}

function makeRunner(max = 3) {
  const pool = new Pool({ root: path.join(tmp(), 'pool'), max });
  pool.init();
  const runner = new Runner({ pool, backend: mockBackend({ speed: 0.01 }) });
  return { pool, runner };
}

const finish = (runner, job) => new Promise((res) => {
  const check = () => { if (job.endedAt) { runner.off('change', check); res(job); } };
  runner.on('change', check); check();
});

test('fingerprint: key changes on any build input, ignores build output', () => {
  const { dir } = makeProject();
  const k0 = computeKey(ctxOf(), dir).key;
  assert.equal(computeKey(ctxOf(), dir).key, k0);
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'junk.swift'), 'x');
  assert.equal(computeKey(ctxOf(), dir).key, k0, 'build/ ignored');
  for (const f of ['Package.resolved', 'Debug.xcconfig', 'Info.plist']) {
    const before = computeKey(ctxOf(), dir).key;
    fs.writeFileSync(path.join(dir, f), String(Math.random()));
    assert.notEqual(computeKey(ctxOf(), dir).key, before, `${f} must change key`);
  }
  assert.notEqual(computeKey(ctxOf({ xcode: 'y' }), dir).key, computeKey(ctxOf(), dir).key, 'Xcode version in key');
});

test('pool: one lease per slot, waiter gets slot after release', async () => {
  const pool = new Pool({ root: path.join(tmp(), 'pool'), max: 1 });
  pool.init();
  const s1 = await pool.acquire(ctxOf(), 'k1');
  assert.ok(fs.existsSync(path.join(s1.path, '.lease')));
  let got = null;
  const p2 = pool.acquire(ctxOf(), 'k1').then((s) => { got = s; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got, null, 'second job must wait');
  pool.release(s1, { ok: true });
  await p2;
  assert.equal(got, s1);
  assert.ok(got.lease, 'lease re-granted');
});

test('pool: affinity prefers exact key and slot bound to wanted target', async () => {
  const pool = new Pool({ root: path.join(tmp(), 'pool'), max: 3 });
  pool.init();
  const a = await pool.acquire(ctxOf(), 'k1'); pool.setKey(a, 'k1', ctxOf(), { path: a.path }); pool.release(a);
  const b = await pool.acquire(ctxOf({ scheme: 'b' }), 'k2'); pool.setKey(b, 'k2', ctxOf({ scheme: 'b' }), { path: b.path }); pool.release(b);
  assert.notEqual(a.id, b.id);
  const again = await pool.acquire(ctxOf({ scheme: 'b' }), 'k2');
  assert.equal(again.id, b.id);
});

test('pool: stale lease from a crashed daemon marks slot dirty, drops key', () => {
  const root = path.join(tmp(), 'pool');
  fs.mkdirSync(path.join(root, 'slot-1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'slot-1', '.lease'), JSON.stringify({ child: { pid: 999999, pgid: 999999, start: 'nope' } }));
  fs.writeFileSync(path.join(root, 'slot-1', '.ddagent-key'), 'k1');
  const saved = { 'slot-1': { id: 'slot-1', path: path.join(root, 'slot-1'), key: 'k1', ctx: ctxOf(), product: { path: '/x' }, bindings: {}, lastUsed: { at: 1, result: 'started' }, dirty: false, createdAt: 1, sizeKB: 0 } };
  const pool = new Pool({ root, saved });
  pool.init();
  const s = pool.slots.get('slot-1');
  assert.equal(s.dirty, true);
  assert.equal(s.key, null);
  assert.equal(s.lastUsed.result, 'interrupted');
  assert.ok(!fs.existsSync(path.join(root, 'slot-1', '.lease')));
});

test('runner: cold -> cache-hit -> incremental; sidecar tamper defeats cache-hit', async () => {
  const { dir, proj } = makeProject();
  const { runner, pool } = makeRunner();
  const run = (extra = {}) => finish(runner, runner.submit({ project: proj, scheme: 'a', targets: ['iPhone 16'], ...extra }));

  const j1 = await run();
  assert.equal(j1.mode, 'cold'); assert.equal(j1.status, 'done');
  const j2 = await run();
  assert.equal(j2.mode, 'cache-hit');
  assert.equal(j2.phases.find((p) => p.name === 'building').status, 'skipped');
  assert.equal(j2.targets[0].phases.find((p) => p.name === 'installing').status, 'skipped', 'already installed with same key');
  assert.equal(j2.slotId, j1.slotId);

  fs.writeFileSync(path.join(dir, 'App.swift'), 'let a = 2');
  const j3 = await run();
  assert.equal(j3.mode, 'incremental');
  assert.equal(j3.slotId, j1.slotId);
  assert.equal(j3.targets[0].phases.find((p) => p.name === 'installing').status, 'done', 'new key => reinstall');

  fs.writeFileSync(path.join(pool.slots.get(j3.slotId).path, '.ddagent-key'), 'tampered');
  const j4 = await run();
  assert.notEqual(j4.mode, 'cache-hit');

  const j5 = await run({ rebuild: true });
  assert.equal(j5.mode, 'cold');
});

test('runner: 3 simulators in one job => one build, slot records bindings + lastUsed', async () => {
  const { proj } = makeProject();
  const { runner, pool } = makeRunner();
  const j = await finish(runner, runner.submit({ project: proj, scheme: 'a', targets: ['iPhone 16', 'iPhone 15', 'iPad'] }));
  assert.equal(j.status, 'done');
  assert.equal(j.phases.filter((p) => p.name === 'building').length, 1);
  const snap = pool.snapshot().find((s) => s.id === j.slotId);
  assert.equal(snap.bindings.length, 3);
  assert.equal(snap.state, 'idle');
  assert.equal(snap.lastUsed.result, 'ok');
});

test('runner: two different projects in parallel never share a slot', async () => {
  const a = makeProject(); const b = makeProject();
  const { runner } = makeRunner();
  const [j1, j2] = await Promise.all([
    finish(runner, runner.submit({ project: a.proj, scheme: 'a', targets: ['iPhone 16'] })),
    finish(runner, runner.submit({ project: b.proj, scheme: 'a', targets: ['iPhone 15'] })),
  ]);
  assert.notEqual(j1.slotId, j2.slotId);
  assert.equal(j1.status, 'done'); assert.equal(j2.status, 'done');
});

test('runner: rejects unsafe input', () => {
  const { runner } = makeRunner();
  assert.throws(() => runner.submit({ project: 'rel.xcodeproj', scheme: 'a', targets: ['x'] }));
  const { proj } = makeProject();
  assert.throws(() => runner.submit({ project: proj, scheme: 'a; rm -rf /', targets: ['x'] }));
});

// ---------------------------------------------------------------- lanes (one simulator per agent, max N, FIFO)
const { Lanes } = require('../lib/lanes');
const SIMS = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => ({ udid: `U-${n}`, name: `Sim ${n}`, state: 'Shutdown', kind: 'simulator' }));
const settled = (p) => Promise.race([p.then(() => 'granted'), new Promise((r) => setImmediate(() => r('waiting')))]);

test('lanes: 4 agents run at once, the 5th waits until one releases', async () => {
  const lanes = new Lanes({ max: 4, sims: () => SIMS });
  const got = [1, 2, 3, 4].map((i) => lanes.acquire({ owner: `agent-${i}` }));
  const l = await Promise.all(got.map((g) => g.promise));
  assert.strictEqual(new Set(l.map((x) => x.udid)).size, 4, 'four distinct simulators');
  const fifth = lanes.acquire({ owner: 'agent-5' });
  const sixth = lanes.acquire({ owner: 'agent-6' });
  assert.strictEqual(await settled(fifth.promise), 'waiting');
  assert.strictEqual(lanes.snapshot().waiting.length, 2);
  lanes.release(l[1].id);
  assert.strictEqual(await settled(fifth.promise), 'granted', 'first in queue gets the freed lane');
  assert.strictEqual(await settled(sixth.promise), 'waiting', 'still capped at 4');
  assert.strictEqual(lanes.snapshot().active.length, 4);
  assert.strictEqual((await fifth.promise).udid, l[1].udid, 'freed simulator is reused, not a new one');
});

test('lanes: same owner gets its lane back; after release it prefers its previous simulator', async () => {
  const lanes = new Lanes({ max: 4, sims: () => SIMS });
  const a = await lanes.acquire({ owner: 'x' }).promise;
  assert.strictEqual((await lanes.acquire({ owner: 'x' }).promise).id, a.id, 'idempotent while held');
  const other = await lanes.acquire({ owner: 'y' }).promise;
  lanes.release(a.id);
  lanes.release(other.id);
  assert.strictEqual((await lanes.acquire({ owner: 'y' }).promise).udid, other.udid);
  assert.strictEqual((await lanes.acquire({ owner: 'x' }).promise).udid, a.udid);
});

test('lanes: prefers an already booted simulator; --target filters; unknown target rejects', async () => {
  const sims = SIMS.map((s) => (s.udid === 'U-D' ? { ...s, state: 'Booted' } : s));
  const lanes = new Lanes({ max: 4, sims: () => sims });
  assert.strictEqual((await lanes.acquire({ owner: 'a' }).promise).udid, 'U-D');
  assert.strictEqual((await lanes.acquire({ owner: 'b', want: 'sim c' }).promise).udid, 'U-C');
  await assert.rejects(lanes.acquire({ owner: 'c', want: 'nope' }).promise, /no simulator matches/);
});

test('lanes: a waiter whose simulator is taken does not block others; cancel leaves the queue', async () => {
  const sims = SIMS.slice(0, 3);
  const lanes = new Lanes({ max: 4, sims: () => sims });
  const a = await lanes.acquire({ owner: 'a', want: 'Sim A' }).promise;
  const wantA = lanes.acquire({ owner: 'b', want: 'Sim A' });
  const any = lanes.acquire({ owner: 'c' });
  assert.strictEqual(await settled(any.promise), 'granted');
  assert.strictEqual(await settled(wantA.promise), 'waiting');
  wantA.cancel();
  assert.strictEqual(lanes.snapshot().waiting.length, 0);
  lanes.release(a.id);
  assert.strictEqual(lanes.snapshot().active.length, 1);
});

test('lanes: idle lanes expire, but never while a job still uses the simulator', async () => {
  let busy = new Set();
  const lanes = new Lanes({ max: 2, ttlMs: 1000, sims: () => SIMS, isBusy: (u) => busy.has(u) });
  const a = await lanes.acquire({ owner: 'a' }).promise;
  const b = await lanes.acquire({ owner: 'b' }).promise;
  busy = new Set([a.udid]);
  const later = Date.now() + 5000;
  const gone = lanes.sweep(later);
  assert.deepStrictEqual(gone.map((l) => l.id), [b.id]);
  assert.ok(lanes.get(a.id), 'busy lane survives');
  lanes.touch(a.id);
  assert.deepStrictEqual(lanes.sweep(Date.now()), []);
});

test('pool: same-context build prefers the slot already bound to the lane simulator', async () => {
  const pool = new Pool({ root: path.join(tmp(), 'pool'), max: 4 });
  pool.init();
  const ctx = ctxOf();
  const s1 = await pool.acquire(ctx, 'k1', { jobId: 'j1' });
  const s2 = await pool.acquire(ctx, 'k1b', { jobId: 'j2' });
  assert.notStrictEqual(s1, s2);
  for (const [s, k, u] of [[s1, 'k1', 'U-1'], [s2, 'k1b', 'U-2']]) { pool.setKey(s, k, ctx, { path: '/x', bundleId: 'b' }); pool.bind(s, { udid: u, name: u }, k); pool.release(s, { ok: true }); }
  s2.lastUsed = { udid: 'U-2', name: 'U-2', at: Date.now() + 1000, result: 'ok' }; // s2 is the most recently used
  const again = await pool.acquire(ctx, 'k2', { preferUdid: 'U-1', jobId: 'j3' });
  assert.strictEqual(again, s1, 'incremental build lands in the lane\'s own DerivedData');
});

test('pool: disk floor with nothing running fails fast instead of waiting forever', async () => {
  const pool = new Pool({ root: path.join(tmp(), 'pool'), max: 4, minFreeGB: 1e9 }); // impossible floor
  pool.init();
  await assert.rejects(pool.acquire(ctxOf(), 'k', { jobId: 'j' }), /not enough free disk/);
});
