---
name: ddagent-debug
description: Use when ddagent hits a build error, reports a wrong cache-hit/incremental mode, has a slot stuck on a lease or dirty, a simulator fails to boot/install, or state.json looks wrong
---

# Debug ddagent

1. Check the environment: `ddagent doctor` (add `--mock` if Xcode is unavailable).
2. Inspect state: `ddagent status`, and `~/.ddagent/state.json` (or `$DDAGENT_HOME`) to see which slots are `dirty` and which `bindings` exist.
3. Classify the symptom:
   - **Wrong cache-hit/incremental**: compare the cache key inputs in `lib/fingerprint.js` (`CTX_KEYS`, `EXT`, `SKIP_DIRS`). A build-relevant file type missing from `EXT` does not change the key.
   - **Slot stuck / cannot be allocated**: check the lease and the `DDAGENT_MAX_SLOTS` and `DDAGENT_MIN_FREE_GB` limits in `lib/pool.js`.
   - **Boot/install failure**: transient CoreSimulator errors are retried in `lib/backend.js` (`TRANSIENT`); for anything else read the job log via `/api/jobs/<id>`.
4. Reproduce in mock mode (`DDAGENT_MOCK=1`) before suspecting Xcode.
5. After a fix, run `npm test`.

A stale daemon still holding port 7777 is a common cause: check `curl localhost:7777/api/ping`.
