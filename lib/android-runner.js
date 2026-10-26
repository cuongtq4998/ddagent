'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { KeyedLock } = require('./util');
const { validateRequest, pruneArtifacts, diskFreeOk } = require('./android');

const MODE_BY_TASK = { assembleDebug: 'android-build', connectedDebugAndroidTest: 'android-test' };
const KEEP_ARTIFACT_JOBS = 20;

// One Android job = boot the lane's AVD if needed -> Gradle task -> collect artifacts.
// Jobs live in the iOS Runner's job map (shared dashboard, shared busy set, shared per-target lock and boot limit).
class AndroidRunner {
  constructor({ runner, android, home, minFreeGB = 0, bootTimeoutMs }) {
    this.runner = runner;
    this.android = android;
    this.home = home;
    this.minFreeGB = minFreeGB;
    this.bootTimeoutMs = bootTimeoutMs;
    this.projectLock = new KeyedLock(); // build/ lives in the source tree: one Gradle run per project directory
  }

  artifactsRoot() { return path.join(this.home, 'artifacts'); }

  submit({ project, module, task, lane }) {
    validateRequest({ project, module, task });
    const { runner } = this;
    const job = {
      id: crypto.randomBytes(4).toString('hex'), platform: 'android',
      req: { project, module, task, scheme: `${module}:${task}`, lane: lane.id, prewarm: false },
      status: 'queued', mode: MODE_BY_TASK[task], slotId: null, key: null, phases: [],
      targets: [{ udid: lane.udid, name: lane.name, status: 'queued', phases: [], readyMs: null, error: null }],
      log: [], createdAt: Date.now(), endedAt: null, error: null, artifacts: null, tests: null,
    };
    runner.jobs.set(job.id, job);
    for (const id of [...runner.jobs.keys()].slice(0, -runner.keepJobs)) runner.jobs.delete(id);
    runner.busy.add(lane.udid);
    this._run(job, lane).catch((e) => { job.status = 'failed'; job.error = e.message; })
      .finally(() => {
        runner.busy.delete(lane.udid);
        job.endedAt = Date.now();
        this._done(job);
        runner.emit('change');
      });
    runner.emit('change');
    return job;
  }

  async _run(job, lane) {
    const { runner, android } = this;
    const { project, module, task } = job.req;
    const jt = job.targets[0];
    const avd = lane.name;
    const artifactsDir = path.join(this.artifactsRoot(), lane.id, job.id);
    const projectCacheDir = path.join(this.home, 'android', lane.id, 'project-cache');
    const onLine = (l) => runner._log(job, l);
    job.status = 'running';
    jt.status = 'running';
    if (!diskFreeOk(this.home, this.minFreeGB)) throw new Error(`not enough free disk (< ${this.minFreeGB} GB free); free space or lower DDAGENT_MIN_FREE_GB`);
    fs.mkdirSync(artifactsDir, { recursive: true });
    pruneArtifacts(this.artifactsRoot(), KEEP_ARTIFACT_JOBS);
    job.artifacts = artifactsDir;

    await runner.udidLock.with(lane.udid, async () => {
      let device;
      try {
        device = await runner._phase(job, jt.phases, 'booting', async (p) => {
          const r = await runner.bootSem.with(() => android.ensureBooted(avd, { onLine, timeoutMs: this.bootTimeoutMs }));
          if (!r.started) p.status = 'skipped';
          return r;
        });
        await android.prepareDevice(device.serial);
      } catch (e) {
        jt.status = 'failed';
        jt.error = e.message;
        throw e;
      }
      jt.readyMs = Date.now() - job.createdAt;
      const since = Date.now();
      let buildError = null;
      try {
        await runner._phase(job, jt.phases, 'building', () => this.projectLock.with(project, async () => {
          const r = await android.gradle({ project, module, task, serial: device.serial, projectCacheDir, onLine });
          fs.writeFileSync(path.join(artifactsDir, 'gradle.log'), r.out || '');
          if (r.code) throw new Error(`gradle ${task} failed (${r.code}): ${String(r.out).trim().split('\n').slice(-12).join('\n')}`);
        }));
      } catch (e) { buildError = e; }
      // Evidence is collected even when the build or the tests failed: that is when it is needed most.
      try {
        job.tests = await runner._phase(job, jt.phases, 'collecting', () => android.collect({ project, module, task, serial: device.serial, artifactsDir, since }));
      } catch (e) {
        if (!buildError) buildError = e;
      }
      if (buildError) { jt.status = 'failed'; jt.error = buildError.message; throw buildError; }
      jt.status = 'running-app';
    });
    const bad = job.tests && (job.tests.failures + job.tests.errors) > 0;
    job.status = bad ? 'failed' : 'done';
    if (bad) job.error = `${job.tests.failures + job.tests.errors} test(s) failed`;
  }

  _done(job) {
    const build = job.targets[0].phases.find((p) => p.name === 'building');
    this.runner.emit('history', {
      id: job.id, at: job.createdAt, platform: 'android', status: job.status, mode: job.mode, scheme: job.req.scheme,
      totalMs: job.endedAt - job.createdAt,
      buildMs: build && build.endedAt ? build.endedAt - build.startedAt : 0,
      readyMs: job.targets[0].readyMs || 0,
      targets: job.targets.map((t) => t.name), prewarm: false, tests: job.tests,
    });
  }
}

module.exports = { AndroidRunner };
