'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { Pool } = require('./lib/pool');
const { Runner } = require('./lib/runner');
const { Lanes } = require('./lib/lanes');
const { realBackend, mockBackend } = require('./lib/backend');

const HOME = process.env.DDAGENT_HOME || path.join(os.homedir(), '.ddagent');
const PORT = +process.env.DDAGENT_PORT || 7777;
const MOCK = process.env.DDAGENT_MOCK === '1';
const MAX_LANES = +process.env.DDAGENT_MAX_LANES || 4;
const LANE_TTL_MIN = +process.env.DDAGENT_LANE_TTL_MIN || 30;
const MAX_SLOTS = +process.env.DDAGENT_MAX_SLOTS || MAX_LANES; // one DerivedData per lane
const MIN_FREE_GB = +process.env.DDAGENT_MIN_FREE_GB || 5;

fs.mkdirSync(HOME, { recursive: true });
const tokenFile = path.join(HOME, 'token');
let token;
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* create below */ }
if (!token) {
  // Concurrent first starts: publish the token atomically (write tmp, then link; link fails if it exists)
  // so a loser never reads a half-written file and adopts the winner's token.
  token = crypto.randomBytes(24).toString('hex');
  const tmp = `${tokenFile}.${process.pid}`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  try { fs.linkSync(tmp, tokenFile); } catch { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  fs.rmSync(tmp, { force: true });
}

const store = new Store(path.join(HOME, 'state.json'));
const spmDir = path.join(HOME, 'SourcePackages');
fs.mkdirSync(spmDir, { recursive: true });
const backend = MOCK ? mockBackend({ speed: +process.env.DDAGENT_MOCK_SPEED || 1 }) : realBackend({ spmDir });
const pool = new Pool({ root: path.join(HOME, 'pool'), max: MAX_SLOTS, minFreeGB: MIN_FREE_GB, saved: store.state.slots });
pool.init();
const runner = new Runner({ pool, backend });
const lanes = new Lanes({ max: MAX_LANES, ttlMs: LANE_TTL_MIN * 60000, sims: () => targets, isBusy: (udid) => runner.busy.has(udid) });

let doctor = { running: true, at: null, checks: [] };
let targets = [];
let targetsErr = null;

async function runDoctor() {
  doctor = { ...doctor, running: true };
  try { doctor = { running: false, at: Date.now(), checks: await backend.doctor({ minFreeGB: MIN_FREE_GB, root: HOME }) }; } catch (e) {
    doctor = { running: false, at: Date.now(), checks: [{ name: 'doctor', ok: false, detail: e.message }] };
  }
  broadcast();
}

async function refreshTargets() {
  try { targets = await backend.list(); targetsErr = null; } catch (e) { targetsErr = e.message; }
}

function snapshot() {
  const slots = pool.snapshot();
  const boundTo = new Map();
  for (const s of slots) for (const b of s.bindings) boundTo.set(b.udid, { slot: s.id, stale: b.stale, installedAt: b.installedAt });
  const lastBy = new Map();
  for (const s of pool.slots.values()) if (s.lastUsed) lastBy.set(s.lastUsed.udid, s.lastUsed);
  const stats = {};
  for (const h of store.state.history) {
    if (h.status !== 'done' || !h.mode || h.prewarm) continue;
    const a = stats[h.mode] || (stats[h.mode] = { n: 0, ready: 0, build: 0 });
    a.n++; a.ready += h.readyMs; a.build += h.buildMs;
  }
  for (const a of Object.values(stats)) { a.avgReadyMs = Math.round(a.ready / a.n); a.avgBuildMs = Math.round(a.build / a.n); }
  return {
    now: Date.now(), mock: backend.mock, doctor, targetsError: targetsErr, stats,
    slots,
    lanes: lanes.snapshot(),
    targets: targets.map((t) => ({
      ...t, busy: runner.busy.has(t.udid), boundSlot: (boundTo.get(t.udid) || {}).slot || null,
      stale: !!(boundTo.get(t.udid) || {}).stale, lastRun: lastBy.get(t.udid) || null,
    })),
    jobs: [...runner.jobs.values()].reverse().map((j) => ({
      id: j.id, scheme: j.req.scheme, status: j.status, mode: j.mode, slotId: j.slotId, key: j.key,
      prewarm: !!j.req.prewarm, createdAt: j.createdAt, endedAt: j.endedAt, error: j.error,
      phases: j.phases, targets: j.targets, log: j.log.slice(-12),
    })),
    history: store.state.history.slice(-30).reverse(),
  };
}

const clients = new Set();
let dashboardClaimedAt = 0;
let pending = null;
function broadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    store.state.slots = pool.persistable();
    store.save();
    if (!clients.size) return;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(data);
  }, 100);
}
pool.on('change', broadcast);
runner.on('change', broadcast);
runner.on('history', (h) => {
  store.state.history.push(h);
  store.state.history = store.state.history.slice(-200);
  refreshTargets().then(broadcast); // boot state changed
});

const dashboard = fs.readFileSync(path.join(__dirname, 'dashboard', 'index.html'));
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e5) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid JSON')); } });
  });
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // DNS-rebinding / CSRF defences: Host + Origin allowlist, no CORS headers ever sent.
  if (!allowedHosts.has(req.headers.host)) return json(403, { error: 'bad host' });
  if (req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ''))) return json(403, { error: 'bad origin' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(dashboard);
  }
  if (url.pathname === '/api/ping') return json(200, { ok: true, pid: process.pid, mock: backend.mock });

  const given = req.headers['x-dd-token'] || url.searchParams.get('token');
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(401, { error: 'unauthorized' });

  try {
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === '/api/dashboard/claim') {
      // Whoever claims first opens the dashboard; later callers see it as open. A freshly opened page needs a
      // moment to connect its event stream, so a claim also counts as "open" for a short grace period.
      const open = clients.size > 0 || Date.now() - dashboardClaimedAt < 15000;
      if (!open) dashboardClaimedAt = Date.now();
      return json(200, { open });
    }
    if (url.pathname === '/api/state') return json(200, snapshot());
    const m = /^\/api\/jobs\/(\w+)$/.exec(url.pathname);
    if (m) {
      const j = snapshot().jobs.find((x) => x.id === m[1]);
      return j ? json(200, j) : json(404, { error: 'no such job' });
    }
    if (req.method === 'POST' && url.pathname === '/api/lanes') {
      // Blocks until a lane is free; a client that gives up (closes) leaves the queue.
      const body = await readBody(req);
      const { promise, cancel } = lanes.acquire({ owner: body.owner, want: body.target });
      res.on('close', () => { if (!res.writableEnded) cancel(); });
      const lane = await promise;
      return json(200, lane);
    }
    if (req.method === 'GET' && url.pathname === '/api/lanes') return json(200, lanes.snapshot());
    const lr = /^\/api\/lanes\/(\w+)\/release$/.exec(url.pathname);
    if (req.method === 'POST' && lr) return lanes.release(lr[1]) ? json(200, { ok: true }) : json(404, { error: 'no such lane' });
    if (req.method === 'POST' && (url.pathname === '/api/run' || url.pathname === '/api/prewarm')) {
      const body = await readBody(req);
      let laneTargets = body.targets;
      if (body.lane) {
        const lane = lanes.get(body.lane);
        if (!lane) throw new Error('no such lane (released or expired); acquire a new one');
        lanes.touch(lane.id);
        laneTargets = [lane.udid];
      }
      const job = runner.submit({
        project: body.project, scheme: body.scheme, config: body.config, targets: laneTargets, lane: body.lane || null,
        rebuild: !!body.rebuild, prewarm: url.pathname === '/api/prewarm',
      });
      return json(202, { id: job.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/doctor') { await runDoctor(); return json(200, doctor); }
    return json(404, { error: 'not found' });
  } catch (e) {
    return json(400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  fs.writeFileSync(path.join(HOME, 'daemon.json'), JSON.stringify({ port: PORT, pid: process.pid, mock: backend.mock }));
  console.log(`ddagent ${backend.mock ? '(MOCK) ' : ''}listening on http://127.0.0.1:${PORT}/#token=${token}`);
  await Promise.all([runDoctor(), refreshTargets()]);
  broadcast();
  setInterval(async () => { await refreshTargets(); broadcast(); }, 5000).unref();
  setInterval(() => lanes.sweep(), 30000).unref();
  lanes.on('change', broadcast);
  setInterval(() => { for (const s of pool.slots.values()) pool.refreshSize(s).catch(() => {}); }, 60000).unref();
});

const shutdown = () => { store.flush(); fs.rmSync(path.join(HOME, 'daemon.json'), { force: true }); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
