---
name: goto
description: Navigate the running app to a named screen using the navigation map, self-healing stale edges on the way. Use for "go to the Loans screen", "open settings in the app", or as a building block before manual poking.
---

# shakedown goto

Drive the app to a target screen using the map.

## 1. Resolve

```bash
shakedown map route <screen> --platform <p> [--from <current>]
```

If the target screen is not in the map, offer `/shakedown:map <screen>` instead of guessing.

If you do not know where the app currently is, find out first:

```bash
shakedown screen identify --platform <p> --device <d>
```

Best match ≥ 0.6 → pass it as `--from`. No good match → relaunch the app (`shakedown app launch`) and route from the anchor.

## 2. Walk the route

For each step of the route:

1. Perform the action: `shakedown ui tap --id/--label <target>` (per the edge's action).
2. Confirm arrival: `shakedown screen verify <step.to> --platform <p> --device <d>`
3. On success, refresh the edge's timestamp:
   `shakedown map set-health --file <map> --from <a> --to <b> --health ok --verified-now`

## 3. On failure

If a tap target is missing or verify fails: dispatch the `shakedown-healer` agent with the failed edge, the platform/device, and the map path. The healer diagnoses (moved target / changed signature / new intermediate screen / removed feature), fixes the map, and verifies the repair. Then re-resolve the route from the current position and continue.

If the healer marks the edge broken and no alternative route exists, report exactly which transition died — that is a real finding about the app, not a tooling failure.

## 4. Report

Confirm arrival with a screenshot (`shakedown ui screenshot`), state route taken, edges re-verified, and any map edits the healer made.
