'use strict';
const { spawn, spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const r = this.q.shift();
    if (r) r(); else this.n++;
  }
  async with(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

// Serialises work per key (e.g. one operation at a time per simulator UDID).
class KeyedLock {
  constructor() { this.tails = new Map(); }
  async with(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function killTree(child, detached) {
  try {
    if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

// Always spawn with an argument array — never through a shell.
function run(cmd, args, o = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd, env: o.env || process.env, detached: !!o.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (o.onSpawn) o.onSpawn(child);
    let out = '';
    let buf = '';
    let timedOut = false;
    const feed = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 2e6) out = out.slice(-1e6);
      if (o.onLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { o.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const t = o.timeout ? setTimeout(() => { timedOut = true; killTree(child, o.detached); }, o.timeout) : null;
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e), timedOut }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code == null ? -1 : code, out, timedOut }); });
  });
}

async function retry(fn, { tries = 3, delay = 800, isTransient = () => true } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (i === tries - 1 || !isTransient(e)) break;
      await sleep(delay * (i + 1));
    }
  }
  throw last;
}

// Start-time string of a pid; used with the pid to defeat PID reuse.
function procStart(pid) {
  if (!pid) return null;
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const s = (r.stdout || '').trim();
  return r.status === 0 && s ? s : null;
}

const lastLines = (s, n = 12) => String(s).trim().split('\n').slice(-n).join('\n');

module.exports = { sleep, Semaphore, KeyedLock, run, retry, procStart, killTree, lastLines };
