---
name: ddagent-lane
description: Use when an agent needs to run an app or tests on an iOS/iPadOS simulator or an Android emulator through ddagent while other agents do the same. Acquire a lane (one dedicated device, max 4 shared), run, then release it
---

# Use a simulator or emulator through a ddagent lane

Each agent holds **one lane = one existing device** for the whole session: an iOS/iPadOS simulator, or an Android virtual device (AVD) with `--platform android`. At most 4 lanes exist at once (iOS and Android together); a fifth agent waits until a lane is released. ddagent never creates simulators or AVDs, it only reuses them.

iOS:

```
LANE=$(ddagent lane acquire --owner <agent-name>)      # waits while all 4 lanes are busy; prints the lane id
ddagent run --lane $LANE --project <path>.xcodeproj --scheme <scheme>   # repeat after every code change
ddagent lane release $LANE                              # REQUIRED when done, even on failure
```

Android (the host needs JDK 17+, the Android SDK, one AVD and a `gradlew`; check with `ddagent doctor --platform android`):

```
LANE=$(ddagent lane acquire --platform android --owner <agent-name> [--target <avd name>])
ddagent run --lane $LANE --project <android dir> --module app --task assembleDebug
ddagent run --lane $LANE --project <android dir> --module app --task connectedDebugAndroidTest
ddagent lane release $LANE                              # REQUIRED; stops the emulator ddagent booted
```

If `ddagent` is not on `PATH` (for example you run it from a clone), define a shell function, not a variable: `ddagent() { node /abs/path/to/ddagent/bin/ddagent "$@"; }`. A variable such as `D="node /path/bin/ddagent"; $D ...` is not split into words in zsh and fails with "command not found".

Rules:
- Always `release` when done. An abandoned lane is released after `DDAGENT_LANE_TTL_MIN` minutes (default 30), and only when no job is running.
- Use the same `--owner` for the same agent: re-acquiring returns the same lane or device, and the next iOS `run` reuses the old DerivedData (incremental / cache-hit). One owner may hold one lane per platform.
- To pick a specific device: `lane acquire --target "iPhone 17"` or `--platform android --target Medium_Phone_API_36.1`.
- `lane list` shows held lanes (with platform) and the queue; `status` shows DerivedData slots and every simulator and AVD.
- The dashboard opens by default on the first `run` or `lane acquire`, so the human can watch every agent; later agents do not reopen it. Never pass `--no-open` or set `DDAGENT_NO_OPEN` yourself: only the human may turn it off.
- iOS runs need `DEVELOPER_DIR` pointing at a full Xcode (and `DDAGENT_MOCK` unset). Keep `DDAGENT_MAX_SLOTS` >= the lane count (defaults to `DDAGENT_MAX_LANES`, 4).
- If a job reports "not enough free disk": free disk space or lower `DDAGENT_MIN_FREE_GB`.
- Android only: `--task` is `assembleDebug` or `connectedDebugAndroidTest` and `--project` is the Android project directory. The `run` output ends with test counts and an `artifacts:` folder (JUnit XML, logcat, screenshots); read it, and quote real counts in your report. The artifacts are collected even when the build fails.
- Android only: two lanes on the same project directory build one after the other. For parallel builds use separate git worktrees. A run that dies with "did not finish booting" means the emulator is too slow or broken: report it, do not retry in a loop.
- `prewarm` and `--scheme` are iOS only.
