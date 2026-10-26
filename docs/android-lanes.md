# Android lanes: design note

Goal: let agents run Android apps and instrumented tests on Android emulators through the same `lane` workflow as iOS simulators.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Lane = | One **existing** AVD (`emulator -list-avds`). ddagent never creates AVDs. | Mirrors iOS: lanes reuse simulators. |
| Lane limit and queue | **Shared** with iOS: one cap (`DDAGENT_MAX_LANES`), one FIFO queue. A waiter that wants a platform/target nobody can serve right now does not block later waiters (existing behavior). | The cap protects host CPU, RAM and disk, which iOS and Android lanes consume alike. A per-platform cap can be added later without an API change. |
| Acquire | `lane acquire --platform ios\|android [--target <name>]`. Default platform: `ios` (backward compatible). | |
| Target id | `avd:<AVD name>` (cannot clash with an iOS UDID). | |
| Build model | No DerivedData slot pool. Gradle runs with a per-lane `--project-cache-dir`; the Gradle user home stays shared (Gradle's default `~/.gradle`, or `DDAGENT_GRADLE_USER_HOME`), because dependency downloads are safe to share and a fresh home would re-download gigabytes. | Gradle has no DerivedData equivalent; its incremental state is the project cache plus `build/`. |
| Same project, two lanes | Gradle runs are serialised per project directory (`KeyedLock`), because `build/` outputs live in the source tree and two builds would corrupt each other. For real parallelism use separate git worktrees. | Safe default, no relocation of build dirs. |
| Emulator lifecycle | Booted on demand: `-no-window -no-snapshot-save -no-boot-anim -no-audio`, free even port in 5554..5584. An emulator ddagent started is stopped when the lane is released or expires, on boot failure, and on daemon shutdown. An emulator that was already running (started by a human) is reused and never killed. | No orphan emulators; never destroy someone else's session. |
| Boot wait | Poll `adb shell getprop sys.boot_completed` every 2 s until it is `1` (the call fails while the device is still offline), timeout `DDAGENT_ANDROID_BOOT_TIMEOUT_S` (default 300). On timeout the process group is killed. | |
| Tasks | Whitelist: `assembleDebug`, `connectedDebugAndroidTest`. Module matches `[A-Za-z0-9_-]+`. Gradle is `<project>/gradlew` only (never a global `gradle`). Spawned with an argument array, never a shell. | Untrusted input stays out of the command line. |
| Artifacts | `~/.ddagent/artifacts/<lane id>/<job id>/`: `junit/*.xml` (copied from the module build), `logcat.txt`, `screenshot-final.png`, `gradle.log`, plus anything the tests wrote to `/sdcard/Pictures/ddagent` (pulled to `device-screenshots/`). Only the newest 20 job folders are kept. | |
| Mock mode | `DDAGENT_MOCK=1` fakes AVDs, boot, Gradle and the artifacts. | Repo rule: develop and test without the real toolchain. |

## Flow of one Android job

```
lane acquire --platform android  ->  lane (avd:NAME)
run --lane L --project DIR --module app --task T
  validate -> disk floor
  booting     ensure AVD booted (skipped if running)      [boot semaphore, per-target lock]
  building    ./gradlew :app:T  (ANDROID_SERIAL = lane emulator, per-lane project cache, per-project lock)
  collecting  junit XML + logcat + screenshots -> artifacts dir (also runs after a failed build)
  failure     job failed; an emulator we started that never finished booting is killed; the lane stays held until release
lane release L  ->  emulator we started is stopped
```

## Not covered

Creating AVDs, physical devices, snapshots, several emulators per lane, per-platform lane caps, parallel Gradle on one project directory, and orphan emulators after a daemon crash (a restarted daemon no longer tracks emulators it started earlier, so it cannot stop them).
