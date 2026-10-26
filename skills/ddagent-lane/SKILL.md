---
name: ddagent-lane
description: Use when an agent needs to run an app on an iOS/iPadOS simulator through ddagent while other agents do the same. Acquire a lane (one dedicated simulator, max 4), run, then release it
---

# Use a simulator through a ddagent lane

Each agent holds **one lane = one existing simulator** for the whole session. At most 4 lanes exist at once; a fifth agent waits until a lane is released. ddagent never creates simulators, it only reuses them.

```
D=ddagent
LANE=$($D lane acquire --owner <agent-name>)      # waits while all 4 lanes are busy; prints the lane id
$D run --lane $LANE --project <path>.xcodeproj --scheme <scheme>   # repeat after every code change
$D lane release $LANE                              # REQUIRED when done, even on failure
```

Rules:
- Always `release` when done. An abandoned lane is released after `DDAGENT_LANE_TTL_MIN` minutes (default 30), and only when no job is running.
- Use the same `--owner` for the same agent: re-acquiring returns the same lane or simulator, and the next `run` reuses the old DerivedData (incremental / cache-hit).
- To pick a specific device: `lane acquire --target "iPhone 17"`.
- `lane list` shows held lanes and the queue; `status` shows the DerivedData slots.
- The first run opens the dashboard once; later agents do not reopen it. Disable with `DDAGENT_NO_OPEN=1` or `--no-open`.
- Real runs need `DEVELOPER_DIR` pointing at a full Xcode (and `DDAGENT_MOCK` unset). Keep `DDAGENT_MAX_SLOTS` >= the lane count (defaults to `DDAGENT_MAX_LANES`, 4).
- If a job reports "not enough free disk": free disk space or lower `DDAGENT_MIN_FREE_GB`.
