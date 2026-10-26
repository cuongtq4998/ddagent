# ddagent

A local daemon, CLI and web dashboard that lets **several coding agents (and humans) build and run an iOS/iPadOS app, or run Android builds and instrumented tests on emulators, on the same Mac without stepping on each other**.

It solves three problems that appear as soon as more than one agent works on an Xcode project:

1. **Slow builds.** Every agent or git worktree starts with an empty DerivedData, so every run is a cold build. ddagent keeps a small pool of DerivedData *slots* and reuses them, so repeat runs are incremental or skipped entirely.
2. **Simulator collisions.** Two agents installing onto the same simulator break each other's runs. ddagent hands out *lanes*: one agent holds one existing simulator exclusively until it releases it.
3. **No visibility.** A live dashboard shows slots, simulators, jobs and timings so you can see what every agent is doing.

![ddagent dashboard while four agents build in parallel](docs/images/dashboard-running.png)
*Four agents building at once: each holds its own lane (simulator) and DerivedData slot, with a live phase timeline and build log per job.*

![ddagent dashboard after the runs finished](docs/images/dashboard-history.png)
*After the runs: cold, incremental and cache-hit timings, which slot serves which simulator, and the run history.*

> The screenshots were captured with Playwright against the daemon in mock mode (fake simulators, no Xcode).

> Status: iOS/iPadOS simulators and Android emulators (existing AVDs). Physical devices are not supported. The Android path is unit-tested in mock mode; see "Android" below for what is not yet verified against a real emulator.

Zero dependencies: Node.js built-ins only.

## Requirements

- macOS with full Xcode (not just Command Line Tools) and at least one available iOS simulator runtime. Use iOS 17.5+ if older runtimes are unreliable on your machine.
- For Android lanes: JDK 17 or newer, the Android SDK (`ANDROID_HOME`, or the default `~/Library/Android/sdk`) with `adb` and `emulator`, at least one existing AVD, and a `gradlew` in the project. Not needed for iOS-only use.
- Node.js 18.15 or newer (`fs.statfsSync` is used for the disk check).
- `git`, and access to GitHub if the repository is private (SSH key or token).

No Xcode? Run everything in mock mode (`--mock` or `DDAGENT_MOCK=1`) to try the workflow with fake simulators.

## Install

```
npm i -g github:cuongtq4998/ddagent      # install; the same command updates it
```

Make sure `$(npm prefix -g)/bin` is on your `PATH`, then check the setup:

```
ddagent doctor            # iOS: xcode-select, xcodebuild, first-launch/license, simulators, free disk
                          # Android: JDK 17+, Android SDK, adb, emulator, AVDs, free disk
ddagent doctor --platform android   # only the Android checks (and --platform ios)
```

If `doctor` reports that Xcode is missing, either run `sudo xcode-select -s /Applications/Xcode.app` once, or prefix commands with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (no sudo).

Install once per machine: there is one daemon per user, shared by every repository on the Mac.

### Add it to a repository (for Claude Code agents)

```
cd your-repo
ddagent init              # add --force to overwrite existing skills
```

`init` copies the `ddagent-lane` and `ddagent-debug` skills into `.claude/skills/` and merges `Bash(ddagent ...)` permissions into `.claude/settings.json`. It never removes existing settings. Commit the result so every agent in the repo picks it up.

## Quick start

```
ddagent run --project /abs/path/App.xcodeproj --scheme App --target "iPhone 16"   # first run: cold build
ddagent run --project /abs/path/App.xcodeproj --scheme App --target "iPhone 16"   # same code: cache-hit
ddagent prewarm --project /abs/path/App.xcodeproj --scheme App --target "iPhone 16"   # build + boot + install, no launch
ddagent status
ddagent dashboard                                                                   # prints the dashboard URL
```

The daemon starts automatically on the first command. `--project` must be an absolute path to an `.xcodeproj` or `.xcworkspace`. `--target` takes a simulator name, a partial name or a UDID, and can be repeated.

## Using it from several agents (lanes)

```
LANE=$(ddagent lane acquire --owner agent-1)          # waits (FIFO) while every lane is busy; prints the lane id
ddagent run --lane $LANE --project /abs/path/App.xcodeproj --scheme App   # repeat after each code change
ddagent lane release $LANE                            # always release, even on failure
ddagent lane list
```

- A lane is one **existing** simulator. ddagent never creates simulators.
- At most `DDAGENT_MAX_LANES` (4) lanes exist; extra requests queue. An abandoned lane is released after `DDAGENT_LANE_TTL_MIN` (30) minutes, never while a job is running.
- Use the same `--owner` for the same agent: it gets the same lane or simulator back, and its next `run` reuses the same DerivedData.
- `lane acquire --target "iPhone 17"` asks for a specific device.

## Android

A lane can also be one **existing Android virtual device (AVD)**. ddagent never creates AVDs; list yours with `emulator -list-avds`.

```
LANE=$(ddagent lane acquire --platform android --owner agent-1 [--target Medium_Phone_API_36.1])
ddagent run --lane $LANE --project /abs/path/to/android --module app --task assembleDebug
ddagent run --lane $LANE --project /abs/path/to/android --module app --task connectedDebugAndroidTest
ddagent lane release $LANE                            # stops the emulator ddagent booted
```

- `--task` is `assembleDebug` or `connectedDebugAndroidTest`; `--module` defaults to `app`. Gradle is always the project's own `./gradlew`.
- The AVD is booted on demand (headless, `-no-snapshot-save`) and ddagent waits for `sys.boot_completed` (`DDAGENT_ANDROID_BOOT_TIMEOUT_S`, default 300). An emulator that was already running is reused and never killed; one ddagent booted is stopped when the lane is released or expires.
- Each lane gets its own Gradle `--project-cache-dir`; the Gradle user home is shared (set `DDAGENT_GRADLE_USER_HOME` to move it). Runs on the same project directory are serialised because `build/` lives in the source tree; use separate git worktrees to build in parallel.
- Evidence goes to `~/.ddagent/artifacts/<lane id>/<job id>/` (the path is printed): `junit/*.xml`, `logcat.txt`, `screenshot-final.png`, `gradle.log`, and anything the tests wrote to `/sdcard/Pictures/ddagent` in `device-screenshots/`. It is collected even when the build or the tests fail. The newest 20 job folders are kept.
- The lane limit (`DDAGENT_MAX_LANES`) and the FIFO queue are shared by iOS and Android lanes.
- iOS-only features (`prewarm`, DerivedData slots, `--scheme`) do not apply to Android lanes.

Design and trade-offs: `docs/android-lanes.md`.

## Commands

| Command | Purpose |
|---|---|
| `ddagent run` / `prewarm` | iOS: build (if needed), boot, install and launch (`prewarm` skips launch). Android lane: boot the AVD, run a Gradle task, collect artifacts (`run` only) |
| `ddagent lane acquire` / `release` / `list` | Exclusive simulator or AVD per agent (`--platform ios\|android`, default `ios`) |
| `ddagent status` | Slots, simulators and AVDs in the terminal |
| `ddagent dashboard` | Print the dashboard URL (includes the access token) |
| `ddagent doctor [--platform ios\|android]` | Environment checks |
| `ddagent init [dir]` | Install skills and permissions into a repository |
| `ddagent start [--mock]` | Run the daemon in the foreground |

Useful flags: `--rebuild` (wipe the slot first), `--config Debug`, `--no-open`, `--mock`.

## How it works

```
ddagent CLI --HTTP--> daemon (server.js)
                        |- Runner       job = allocate slot -> build -> per target: boot -> install -> launch
                        |- Pool         DerivedData slots, build leases, bindings, disk floor
                        |- Lanes        exclusive simulator per agent, FIFO queue, idle expiry
                        |- Fingerprint  cache key from build context + file contents
                        |- AndroidRunner job = boot AVD -> Gradle task -> collect artifacts (shares the job list and device locks)
                        |- Backend      real (xcodebuild/xcrun, plus lib/android.js: adb/emulator/Gradle) or mock
                        '- Store        state.json (only the daemon writes it)
dashboard (browser) <--SSE-- daemon
```

**Build modes.** The cache key is a hash of the project, scheme, configuration, SDK, architecture, Xcode build and SDK versions, plus the contents of every build-relevant file (sources, xcconfig, plist, entitlements, assets, `Package.resolved`, ...).

| Mode | When | Effect |
|---|---|---|
| `cold` | The slot is empty | Full build |
| `incremental` | Same build context, changed sources | `xcodebuild` reuses the slot's intermediates |
| `cache-hit` | Key matches and the product exists | Build skipped, only install/launch |

**Slots and bindings.** A *slot* is one DerivedData directory. A *build lease* is held only while `xcodebuild` runs. A *binding* records which simulator has a slot's product installed, so an unchanged app is not reinstalled. The number of slots is capped by `DDAGENT_MAX_SLOTS`, and no new slot is created when free disk is below `DDAGENT_MIN_FREE_GB`. A slot left behind by a failed build is marked `dirty` and wiped before reuse.

**Parallelism.** Cold builds, simulator boots and package resolution are bounded by semaphores, and the same simulator is never used by two jobs at once.

## Dashboard

Open the URL printed by `ddagent dashboard`. The first `run` or `lane acquire` opens it automatically once; later agents see it already open (disable with `DDAGENT_NO_OPEN=1` or `--no-open`).

The page is served by the daemon on `127.0.0.1` and updates live over a server-sent-events stream (the dot next to the title is green while connected). Sections:

| Section | What it shows |
|---|---|
| Header | Mock-mode indicator and the `doctor` check results (iOS and Android) |
| Lanes | Every held lane (iOS and Android) with owner, device, activity and age, plus the waiting queue |
| Speed | Average time-to-ready and build time for cold, incremental and cache-hit runs |
| DerivedData slots | State (`idle`, `building`, `installing`), cache key, scheme, which simulators it serves (`stale` means the installed key is older than the slot's key), last use, size |
| Simulators / devices | Name, platform, OS, boot state, busy/idle, bound slot, last run (Android AVDs included) |
| Jobs | Phase timeline per job and per target (iOS: allocating-slot, building, booting, installing, launching; Android: booting, building, collecting; skipped phases are greyed), live build log, Android test counts and artifact folder |
| History | The last runs with mode, status, build and ready times |

Access is protected by a random token stored in `~/.ddagent/token` (mode 0600) and sent with every request. The server also rejects requests whose `Host` or `Origin` is not the local address and sends no CORS headers.

## Configuration

State lives in `~/.ddagent` (override with `DDAGENT_HOME`).

| Variable | Default | Meaning |
|---|---|---|
| `DDAGENT_PORT` | 7777 | Daemon port |
| `DDAGENT_MAX_LANES` | 4 | Maximum concurrent lanes, iOS and Android together |
| `DDAGENT_MAX_SLOTS` | = max lanes | Maximum DerivedData slots |
| `DDAGENT_MIN_FREE_GB` | 5 | Below this, no new slot is created and the job fails fast (Android jobs fail fast too) |
| `DDAGENT_ANDROID_BOOT_TIMEOUT_S` | 300 | Seconds to wait for an AVD to finish booting |
| `DDAGENT_GRADLE_USER_HOME` | unset | Gradle user home for Android runs (default: Gradle's own `~/.gradle`) |
| `DDAGENT_LANE_TTL_MIN` | 30 | Idle lane expiry in minutes |
| `DDAGENT_NO_OPEN` | unset | Do not auto-open the dashboard |
| `DDAGENT_MOCK` | unset | `1` = fake simulators, AVDs and builds, no Xcode, emulator or JDK needed |
| `DDAGENT_MOCK_ANDROID_FAIL` | unset | Mock mode only: `boot` or `gradle` makes the fake Android job fail (for testing failure paths) |
| `DDAGENT_MOCK_SPEED` | 1 | Scale mock delays |

## For agents

Read the skills installed by `ddagent init`:

- `ddagent-lane`: acquire a lane (iOS simulator or Android AVD), run, release. Always release.
- `ddagent-debug`: wrong cache-hit/incremental, stuck slots, boot/install failures, odd `state.json`.

Rules of thumb: reuse the same `--owner`; never create simulators or AVDs yourself; if a stale daemon holds the port, check `curl localhost:7777/api/ping`.

## Troubleshooting

- `doctor` fails on `xcode-select`: point it at a full Xcode (see Install). On a host without Xcode use `ddagent doctor --platform android`.
- `doctor` fails on `JDK 17+`: install a JDK 17 or newer and set `JAVA_HOME` (on macOS ddagent also asks `/usr/libexec/java_home -v 17`).
- Android job fails with "did not finish booting": the emulator log is `~/.ddagent/android/emulator-<avd>.log`; raise `DDAGENT_ANDROID_BOOT_TIMEOUT_S` on a slow host.
- "not enough free disk": free space or lower `DDAGENT_MIN_FREE_GB`.
- All lanes busy: wait, or run `ddagent lane list` to see who holds them.
- Wrong cache result: a build-relevant file type may be missing from `EXT` in `lib/fingerprint.js`.
- Unknown state: inspect `~/.ddagent/state.json`.

## Development

```
npm test                       # node --test test/ddagent.test.js test/android.test.js
DDAGENT_MOCK=1 node server.js  # run the daemon directly in mock mode
```

Constraints: Node built-ins only (CommonJS, `'use strict'`); every backend operation exists in both `realBackend` and `mockBackend`; only the daemon writes `state.json`; develop and test in mock mode. See `CLAUDE.md`.
