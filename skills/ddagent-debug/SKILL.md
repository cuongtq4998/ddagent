---
name: ddagent-debug
description: Use when ddagent hits a build error, reports a wrong cache-hit/incremental mode, has a slot stuck on a lease or dirty, a simulator or Android emulator fails to boot/install, an Android Gradle run fails, or state.json looks wrong
---

# Debug ddagent

1. Check the environment: `ddagent doctor` (add `--platform android` or `--platform ios` to limit it, `--mock` if Xcode or the Android SDK is unavailable).
2. Inspect state: `ddagent status`, and `~/.ddagent/state.json` (or `$DDAGENT_HOME`) to see which slots are `dirty` and which `bindings` exist.
3. Classify the symptom:
   - **Wrong cache-hit/incremental**: compare the cache key inputs in `lib/fingerprint.js` (`CTX_KEYS`, `EXT`, `SKIP_DIRS`). A build-relevant file type missing from `EXT` does not change the key.
   - **Slot stuck / cannot be allocated**: check the lease and the `DDAGENT_MAX_SLOTS` and `DDAGENT_MIN_FREE_GB` limits in `lib/pool.js`.
   - **Boot/install failure**: transient CoreSimulator errors are retried in `lib/backend.js` (`TRANSIENT`); for anything else read the job log via `/api/jobs/<id>`.
   - **Android emulator does not boot**: read `~/.ddagent/android/emulator-<avd>.log` (or `$DDAGENT_HOME/android/`), check free disk, and `adb devices`; the wait is `DDAGENT_ANDROID_BOOT_TIMEOUT_S`. ddagent only kills emulators it booted itself (`ensureBooted` / `stopStarted` in `lib/android.js`).
   - **Android Gradle failure**: the job error holds the last Gradle lines; the full log is `gradle.log` in the job's artifact folder (`~/.ddagent/artifacts/<lane>/<job>/`). `JDK 17+ not found` means `JAVA_HOME` is wrong (see `doctor`). Two lanes on one project directory wait for each other by design.
   - **Android test counts are 0**: JUnit XML is read from `<module>/build/outputs/androidTest-results/connected` and `<module>/build/test-results`, only files newer than the run start (`newJunitFiles` in `lib/android.js`).
4. Reproduce in mock mode (`DDAGENT_MOCK=1`) before suspecting Xcode.
5. After a fix, run `npm test`.

A stale daemon still holding port 7777 is a common cause: check `curl localhost:7777/api/ping`.
