# ddagent

Local daemon + web dashboard that manages a pool of Xcode DerivedData slots for many iOS simulators.

## Use
```
# one-time (real mode): sudo xcode-select -s /Applications/Xcode.app
ddagent doctor
ddagent run --target "iPhone 16" --target "iPad"   # first run: cold build
ddagent run --target "iPhone 16"                   # same code: cache-hit
ddagent prewarm --target "iPhone 16"               # build + boot + install, no launch
ddagent status
ddagent dashboard                                  # prints the URL with token
```
Add `--mock` (or `DDAGENT_MOCK=1`) to try it without Xcode. State lives in `~/.ddagent` (override with `DDAGENT_HOME`).

Env: `DDAGENT_PORT` (7777), `DDAGENT_MAX_SLOTS` (3), `DDAGENT_MIN_FREE_GB` (5).

## Lanes (many agents)
```
LANE=$(ddagent lane acquire --owner agent-1)   # blocks while all lanes are busy
ddagent run --lane $LANE --project X.xcodeproj
ddagent lane release $LANE
ddagent lane list
```
A lane holds one existing simulator for one agent. `DDAGENT_MAX_LANES` (4) caps concurrency; extra requests queue FIFO. Idle lanes expire after `DDAGENT_LANE_TTL_MIN` (30). The first `run`/`lane acquire` opens the dashboard once (`DDAGENT_NO_OPEN=1` to disable).

## Modes
- `cold`: empty slot, full build. `incremental`: same project/scheme/config/Xcode, changed sources. `cache-hit`: key matches sidecar and product exists, build skipped.
- Cache key = project, scheme, config, sdk, arch, Xcode build + SDK, and content of sources/xcconfig/plist/entitlements/Package.resolved.

## Test
`node --test test/ddagent.test.js`
