'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

// A lane = one agent's exclusive hold on one existing simulator or Android virtual device (AVD), for as long as the agent works.
//  - at most `max` lanes at once, shared by every platform; the next acquire waits (FIFO) until a lane is released or expires
//  - devices are never created, only reused: same owner gets its lane / previous device back
//  - a target without `platform` is an iOS simulator (backward compatible)
const DEFAULT_PLATFORM = 'ios';
const platformOf = (t) => t.platform || DEFAULT_PLATFORM;

class Lanes extends EventEmitter {
  constructor({ max = 4, ttlMs = 30 * 60 * 1000, sims = () => [], isBusy = () => false } = {}) {
    super();
    this.max = max;
    this.ttlMs = ttlMs;
    this.sims = sims;       // () => [{udid,name,state,...}], synchronous (daemon keeps a cached list)
    this.isBusy = isBusy;   // udid => a job is still using it, so the lane is not idle
    this.lanes = new Map();
    this.waiters = [];
    this.lastByOwner = new Map();
  }

  get(id) { return this.lanes.get(id) || null; }
  held() { return new Set([...this.lanes.values()].map((l) => l.udid)); }

  _match(want, platform = DEFAULT_PLATFORM) {
    const all = this.sims().filter((s) => platformOf(s) === platform);
    if (!want) return all;
    const q = want.toLowerCase();
    return all.filter((s) => s.udid === want || s.name.toLowerCase() === q || s.name.toLowerCase().includes(q));
  }

  _pick(w) {
    const held = this.held();
    const prev = this.lastByOwner.get(w.owner);
    const score = (s) => (s.udid === prev ? 4 : 0) + (s.state === 'Booted' ? 2 : 0);
    const free = this._match(w.want, w.platform).filter((s) => !held.has(s.udid));
    free.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
    return free[0] || null;
  }

  // -> { promise, cancel }. promise resolves with the lane once one is free.
  acquire({ owner, want, platform = DEFAULT_PLATFORM } = {}) {
    owner = String(owner || 'anon');
    const mine = [...this.lanes.values()].find((l) => l.owner === owner && l.platform === platform
      && (!want || this._match(want, platform).some((s) => s.udid === l.udid)));
    if (mine) { this.touch(mine.id); return { promise: Promise.resolve(mine), cancel() {} }; }
    if (!this._match(want, platform).length) {
      const what = platform === DEFAULT_PLATFORM ? 'simulator' : `${platform} device`;
      return { promise: Promise.reject(new Error(want ? `no ${what} matches: ${want}` : `no ${what} available`)), cancel() {} };
    }
    let w;
    const promise = new Promise((resolve) => { w = { owner, want, platform, resolve, at: Date.now() }; });
    this.waiters.push(w);
    this._drain();
    this.emit('change');
    return { promise, cancel: () => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); this.emit('change'); } } };
  }

  _drain() {
    for (let i = 0; i < this.waiters.length && this.lanes.size < this.max;) {
      const w = this.waiters[i];
      const sim = this._pick(w);
      if (!sim) { i++; continue; } // only simulators it wants are taken: let later waiters pass
      this.waiters.splice(i, 1);
      const now = Date.now();
      const lane = {
        id: crypto.randomBytes(4).toString('hex'), owner: w.owner, platform: w.platform, udid: sim.udid, name: sim.name,
        acquiredAt: now, lastActive: now, waitedMs: now - w.at,
      };
      this.lanes.set(lane.id, lane);
      this.lastByOwner.set(w.owner, sim.udid);
      w.resolve(lane);
    }
  }

  touch(id) { const l = this.lanes.get(id); if (l) l.lastActive = Date.now(); }

  release(id) {
    const lane = this.lanes.get(id);
    if (!lane) return false;
    this.lanes.delete(id);
    this.emit('released', lane);
    this._drain();
    this.emit('change');
    return true;
  }

  // Free lanes whose agent went silent; never one that still has a job running.
  sweep(now = Date.now()) {
    const out = [];
    for (const l of [...this.lanes.values()]) {
      if (now - l.lastActive > this.ttlMs && !this.isBusy(l.udid)) { this.release(l.id); out.push(l); }
    }
    return out;
  }

  snapshot() {
    return {
      max: this.max,
      active: [...this.lanes.values()].map((l) => ({ ...l, busy: this.isBusy(l.udid) })),
      waiting: this.waiters.map((w) => ({ owner: w.owner, platform: w.platform, want: w.want || null, since: w.at })),
    };
  }
}

module.exports = { Lanes };
