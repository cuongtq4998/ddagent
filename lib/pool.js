'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { run, procStart } = require('./util');
const { sameCtx } = require('./fingerprint');

const SLOT_FIELDS = ['id', 'path', 'key', 'ctx', 'product', 'bindings', 'lastUsed', 'dirty', 'createdAt', 'sizeKB'];

// Pool of DerivedData slots.
//  - build lease : held only while xcodebuild runs (slot.lease)
//  - bindings    : slot -> targets that have this slot's product installed (persisted)
class Pool extends EventEmitter {
  constructor({ root, max = 3, minFreeGB = 0, saved = {} }) {
    super();
    this.root = root;
    this.max = max;
    this.minFreeGB = minFreeGB;
    this.slots = new Map();
    this.waiters = [];
    for (const s of Object.values(saved)) this.slots.set(s.id, { ...s, lease: null, pins: 0, hb: null });
  }

  init() {
    fs.mkdirSync(this.root, { recursive: true });
    for (const slot of this.slots.values()) {
      fs.mkdirSync(slot.path, { recursive: true });
      this._reconcile(slot);
    }
    this.emit('change');
  }

  // Rebuild truth from disk after a (possibly crashed) restart.
  _reconcile(slot) {
    const lf = this._leaseFile(slot);
    if (fs.existsSync(lf)) {
      try {
        const l = JSON.parse(fs.readFileSync(lf, 'utf8'));
        const c = l.child;
        if (c && procStart(c.pid) === c.start) { // same process, not a reused pid
          try { process.kill(-c.pgid, 'SIGKILL'); } catch { /* gone */ }
        }
      } catch { /* corrupt lease: treat as stale */ }
      fs.rmSync(lf, { force: true });
      this._markDirty(slot);
      if (slot.lastUsed) slot.lastUsed = { ...slot.lastUsed, result: 'interrupted' };
    }
    let sidecar = null;
    try { sidecar = fs.readFileSync(this._sidecar(slot), 'utf8').trim(); } catch { /* none */ }
    if (slot.key && sidecar !== slot.key) { slot.key = null; slot.product = null; }
  }

  _leaseFile(slot) { return path.join(slot.path, '.lease'); }
  _sidecar(slot) { return path.join(slot.path, '.ddagent-key'); }

  _markDirty(slot) {
    slot.dirty = true;
    slot.key = null;
    slot.product = null;
    fs.rmSync(this._sidecar(slot), { force: true });
  }

  acquire(ctx, key, { preferUdid, jobId } = {}) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ ctx, key, preferUdid, jobId, resolve, reject, at: Date.now() });
      this._drain();
      this.emit('change');
    });
  }

  _free() { return [...this.slots.values()].filter((s) => !s.lease && s.pins === 0); }
  _recency(s) { return (s.lastUsed && s.lastUsed.at) || s.createdAt; }

  _diskOk() {
    if (!this.minFreeGB || !fs.statfsSync) return true;
    try {
      const st = fs.statfsSync(this.root);
      return (st.bavail * st.bsize) / 1e9 >= this.minFreeGB;
    } catch { return true; }
  }

  _pick(w) {
    const free = this._free();
    const byRecent = (a, b) => this._recency(b) - this._recency(a);
    // 1. exact cache hit; prefer the slot already bound to the wanted target
    const exact = free.filter((s) => s.key && s.key === w.key).sort(byRecent);
    if (exact.length) return exact.find((s) => w.preferUdid && s.bindings[w.preferUdid]) || exact[0];
    // 2. same project/scheme/config/Xcode => incremental build
    const same = free.filter((s) => sameCtx(s.ctx, w.ctx)).sort(byRecent);
    if (same.length) return same.find((s) => w.preferUdid && s.bindings[w.preferUdid]) || same[0];
    // 3. clean slot
    const empty = free.filter((s) => !s.ctx && !s.key);
    if (empty.length) return empty[0];
    // 4. new slot (cap + disk floor)
    if (this.slots.size < this.max && this._diskOk()) return this._create();
    // 5. LRU idle slot of another context, wiped (never a leased/pinned one)
    const lru = free.sort((a, b) => this._recency(a) - this._recency(b))[0];
    if (lru) { this._wipe(lru); return lru; }
    return null;
  }

  _create() {
    let n = 0;
    for (const s of this.slots.values()) n = Math.max(n, +s.id.split('-')[1] || 0);
    const id = `slot-${n + 1}`;
    const slot = {
      id, path: path.join(this.root, id), key: null, ctx: null, product: null, bindings: {},
      lastUsed: null, dirty: false, createdAt: Date.now(), sizeKB: 0, lease: null, pins: 0, hb: null,
    };
    fs.mkdirSync(slot.path, { recursive: true });
    this.slots.set(id, slot);
    return slot;
  }

  _wipe(slot) {
    fs.rmSync(slot.path, { recursive: true, force: true });
    fs.mkdirSync(slot.path, { recursive: true });
    Object.assign(slot, { key: null, ctx: null, product: null, bindings: {}, dirty: false });
  }

  wipe(slot) { this._wipe(slot); this._changed(); }

  _drain() {
    for (let i = 0; i < this.waiters.length;) {
      const w = this.waiters[i];
      const slot = this._pick(w);
      if (!slot && this.slots.size < this.max && !this._diskOk() && ![...this.slots.values()].some((x) => x.lease || x.pins > 0)) {
        // Blocked only by the disk floor and nothing is running that could free a slot: waiting would hang forever.
        this.waiters.splice(i, 1);
        w.reject(new Error(`not enough free disk to create a DerivedData slot (< ${this.minFreeGB} GB free); free space or lower DDAGENT_MIN_FREE_GB`));
        continue;
      }
      if (!slot) { i++; continue; }
      this.waiters.splice(i, 1);
      this._grant(slot, w);
      w.resolve(slot);
    }
  }

  _writeLease(slot) {
    fs.writeFileSync(this._leaseFile(slot), JSON.stringify(slot.lease));
  }

  _grant(slot, w) {
    if (slot.dirty) { // crashed/failed build left junk behind
      fs.rmSync(path.join(slot.path, 'Build', 'Intermediates.noindex'), { recursive: true, force: true });
      slot.dirty = false;
    }
    const now = Date.now();
    slot.lease = { jobId: w.jobId, daemon: process.pid, at: now, heartbeat: now, child: null };
    fs.writeFileSync(this._leaseFile(slot), JSON.stringify(slot.lease), { flag: 'wx' }); // O_EXCL
    slot.hb = setInterval(() => { slot.lease.heartbeat = Date.now(); this._writeLease(slot); }, 5000);
    slot.hb.unref();
  }

  // Record the xcodebuild process group so a crashed daemon's orphan can be killed.
  setChild(slot, child) {
    if (!slot.lease || !child || !child.pid) return;
    slot.lease.child = { pid: child.pid, pgid: child.pid, start: procStart(child.pid) };
    this._writeLease(slot);
  }

  pin(slot) { slot.pins++; }
  unpin(slot) { slot.pins = Math.max(0, slot.pins - 1); this._drain(); this._changed(); }

  release(slot, { ok = true } = {}) {
    clearInterval(slot.hb);
    slot.hb = null;
    slot.lease = null;
    fs.rmSync(this._leaseFile(slot), { force: true });
    if (!ok) this._markDirty(slot);
    this._drain();
    this._changed();
  }

  setKey(slot, key, ctx, product) {
    slot.key = key;
    slot.ctx = ctx;
    slot.product = product;
    fs.writeFileSync(this._sidecar(slot), key); // only after a successful build
    this._changed();
  }

  // Product still on disk and built from exactly this key?
  isHit(slot, key) {
    if (!slot.key || slot.key !== key || !slot.product || !fs.existsSync(slot.product.path)) return false;
    try { return fs.readFileSync(this._sidecar(slot), 'utf8').trim() === key; } catch { return false; }
  }

  bind(slot, target, installedKey) {
    for (const s of this.slots.values()) if (s !== slot) delete s.bindings[target.udid];
    slot.bindings[target.udid] = { name: target.name, kind: 'simulator', installedKey, installedAt: Date.now() };
    this._changed();
  }

  // Written when a job starts (not only at the end) so a crash keeps it.
  touch(slot, target, result) {
    slot.lastUsed = { udid: target.udid, name: target.name, kind: 'simulator', at: Date.now(), result };
    this._changed();
  }

  async refreshSize(slot) {
    const r = await run('du', ['-sk', slot.path], { timeout: 60000 });
    const kb = parseInt(r.out, 10);
    if (!Number.isNaN(kb)) { slot.sizeKB = kb; this._changed(); }
  }

  _changed() { this.emit('change'); }

  persistable() {
    const out = {};
    for (const s of this.slots.values()) {
      out[s.id] = Object.fromEntries(SLOT_FIELDS.map((k) => [k, s[k]]));
    }
    return out;
  }

  snapshot() {
    return [...this.slots.values()].map((s) => ({
      id: s.id,
      state: s.lease ? 'building' : s.pins > 0 ? 'installing' : 'idle',
      dirty: s.dirty,
      key: s.key,
      scheme: s.ctx && s.ctx.scheme,
      jobId: s.lease ? s.lease.jobId : null,
      bindings: Object.entries(s.bindings).map(([udid, b]) => ({
        udid, ...b, stale: !!s.key && b.installedKey !== s.key,
      })),
      lastUsed: s.lastUsed,
      sizeKB: s.sizeKB,
      waiting: this.waiters.length,
    }));
  }
}

module.exports = { Pool };
