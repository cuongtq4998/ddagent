'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Semaphore, KeyedLock } = require('./util');
const { computeKey } = require('./fingerprint');

const SAFE = /^[\w .+\-]+$/;

// One job = allocate slot -> (build) -> for each target: boot -> install -> launch
class Runner extends EventEmitter {
  constructor({ pool, backend, coldParallel = 2, bootParallel = 3, keepJobs = 30 }) {
    super();
    this.pool = pool;
    this.backend = backend;
    this.jobs = new Map();
    this.keepJobs = keepJobs;
    this.coldSem = new Semaphore(coldParallel);
    this.bootSem = new Semaphore(bootParallel);
    this.resolveSem = new Semaphore(1); // package resolve is serialised
    this.udidLock = new KeyedLock();
    this.busy = new Set();
    this.xcode = null;
  }

  validate(req) {
    const p = req.project;
    if (!p || !path.isAbsolute(p) || !/\.(xcodeproj|xcworkspace)$/.test(p) || !fs.existsSync(p)) throw new Error('project must be an existing absolute .xcodeproj/.xcworkspace path');
    if (!SAFE.test(req.scheme || '')) throw new Error('invalid scheme');
    if (req.config && !SAFE.test(req.config)) throw new Error('invalid configuration');
    if (!Array.isArray(req.targets) || !req.targets.length || req.targets.some((t) => typeof t !== 'string')) throw new Error('targets must be a non-empty list of names/udids');
  }

  submit(req) {
    this.validate(req);
    const job = {
      id: crypto.randomBytes(4).toString('hex'), req, status: 'queued', mode: null, slotId: null, key: null,
      phases: [], targets: [], log: [], createdAt: Date.now(), endedAt: null, error: null,
    };
    this.jobs.set(job.id, job);
    for (const id of [...this.jobs.keys()].slice(0, -this.keepJobs)) this.jobs.delete(id);
    this._run(job).catch((e) => { job.status = 'failed'; job.error = e.message; })
      .finally(() => { job.endedAt = Date.now(); this._done(job); this.emit('change'); });
    this.emit('change');
    return job;
  }

  _log(job, line) {
    job.log.push(line);
    if (job.log.length > 40) job.log.shift();
    this._throttled();
  }

  _throttled() {
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.emit('change'); }, 150);
    this._t.unref();
  }

  async _phase(job, list, name, fn) {
    const p = { name, startedAt: Date.now(), endedAt: null, status: 'running' };
    list.push(p);
    this.emit('change');
    try {
      const r = await fn(p);
      if (p.status === 'running') p.status = 'done';
      return r;
    } catch (e) {
      p.status = 'failed';
      p.error = e.message;
      throw e;
    } finally { p.endedAt = Date.now(); this.emit('change'); }
  }

  async _resolveTargets(names) {
    const all = await this.backend.list();
    return names.map((n) => {
      const q = n.toLowerCase();
      const t = all.find((x) => x.udid === n) || all.find((x) => x.name.toLowerCase() === q)
        || all.find((x) => x.name.toLowerCase().includes(q));
      if (!t) throw new Error(`target not found: ${n}`);
      return t;
    });
  }

  async _run(job) {
    const { pool, backend } = this;
    const req = job.req;
    const t0 = job.createdAt;
    if (!this.xcode) this.xcode = await backend.xcodeVersion();
    const targets = await this._resolveTargets(req.targets);
    job.targets = targets.map((t) => ({ udid: t.udid, name: t.name, status: 'queued', phases: [], readyMs: null, error: null }));
    const ctx = {
      projectPath: req.project, scheme: req.scheme, config: req.config || 'Debug',
      sdk: 'iphonesimulator', arch: 'arm64', xcode: this.xcode,
    };
    const fp = computeKey(ctx, path.dirname(req.project));
    job.key = fp.key;
    job.status = 'running';

    const slot = await this._phase(job, job.phases, 'allocating-slot',
      () => pool.acquire(ctx, fp.key, { preferUdid: targets[0].udid, jobId: job.id }));
    job.slotId = slot.id;
    for (const t of targets) { pool.touch(slot, t, 'started'); this.busy.add(t.udid); }

    try {
      if (req.rebuild) pool.wipe(slot);
      job.mode = pool.isHit(slot, fp.key) ? 'cache-hit' : (slot.ctx && slot.key ? 'incremental' : 'cold');
      await this._build(job, slot, ctx, fp);
      pool.pin(slot); // keep the product safe from eviction while installing
    } catch (e) {
      pool.release(slot, { ok: false });
      for (const t of targets) { this.busy.delete(t.udid); pool.touch(slot, t, 'build-failed'); }
      throw e;
    }
    pool.release(slot, { ok: true });
    pool.refreshSize(slot).catch(() => {});

    const startedAt = Date.now();
    try {
      const results = await Promise.allSettled(targets.map((t, i) => this._target(job, slot, t, job.targets[i], fp.key, t0)));
      const bad = results.filter((r) => r.status === 'rejected').length;
      job.status = bad === 0 ? 'done' : bad === results.length ? 'failed' : 'partial';
      if (bad) job.error = `${bad}/${results.length} target(s) failed`;
    } finally {
      pool.unpin(slot);
      for (const t of targets) this.busy.delete(t.udid);
    }
    job.startedAt = startedAt;
  }

  async _build(job, slot, ctx, fp) {
    const { pool, backend } = this;
    if (job.mode === 'cache-hit') {
      job.phases.push({ name: 'building', startedAt: Date.now(), endedAt: Date.now(), status: 'skipped' });
      return;
    }
    const doBuild = () => this._phase(job, job.phases, 'building', async () => {
      const onLine = (l) => this._log(job, l);
      if (fp.hasPackages) await this.resolveSem.with(() => backend.resolve(ctx, slot, { onLine }));
      const product = await backend.build(ctx, slot, {
        onLine, mode: job.mode, disableResolve: fp.hasPackages,
        onSpawn: (child) => pool.setChild(slot, child),
      });
      pool.setKey(slot, fp.key, ctx, product);
    });
    await (job.mode === 'cold' ? this.coldSem.with(doBuild) : doBuild());
  }

  async _target(job, slot, target, jt, key, t0) {
    const { pool, backend } = this;
    const req = job.req;
    jt.status = 'running';
    try {
      await this.udidLock.with(target.udid, async () => {
        const live = (await backend.list()).find((x) => x.udid === target.udid);
        if (!live || live.state !== 'Booted') {
          await this._phase(job, jt.phases, 'booting', () => this.bootSem.with(() => backend.boot(target.udid)));
        } else {
          jt.phases.push({ name: 'booting', startedAt: Date.now(), endedAt: Date.now(), status: 'skipped' });
        }
        const bound = slot.bindings[target.udid];
        if (bound && bound.installedKey === key) {
          jt.phases.push({ name: 'installing', startedAt: Date.now(), endedAt: Date.now(), status: 'skipped' });
        } else {
          await this._phase(job, jt.phases, 'installing', () => backend.install(target.udid, slot.product.path));
          pool.bind(slot, target, key);
        }
        if (req.prewarm) {
          jt.phases.push({ name: 'launching', startedAt: Date.now(), endedAt: Date.now(), status: 'skipped' });
        } else {
          await this._phase(job, jt.phases, 'launching', () => backend.launch(target.udid, slot.product.bundleId));
        }
      });
      jt.status = 'running-app';
      jt.readyMs = Date.now() - t0;
      pool.touch(slot, target, 'ok');
    } catch (e) {
      jt.status = 'failed';
      jt.error = e.message;
      pool.touch(slot, target, 'failed');
      throw e;
    }
  }

  _done(job) {
    this.emit('history', {
      id: job.id, at: job.createdAt, status: job.status, mode: job.mode, scheme: job.req.scheme,
      totalMs: job.endedAt - job.createdAt,
      buildMs: (job.phases.find((p) => p.name === 'building') || {}).endedAt - (job.phases.find((p) => p.name === 'building') || {}).startedAt || 0,
      readyMs: Math.max(0, ...job.targets.map((t) => t.readyMs || 0)),
      targets: job.targets.map((t) => t.name), prewarm: !!job.req.prewarm,
    });
  }
}

module.exports = { Runner };
