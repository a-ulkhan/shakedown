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
2. Confirm arrival and repair drift in one call:
   ```bash
   shakedown screen reconcile <step.to> --platform <p> --device <d> --heal
   ```

## 3. Act on the verdict

`reconcile` answers *why* an arrival check failed, which decides what happens next. Never repair the map yourself based on a bare `verify` failure — the `lost` case looks identical and repairing it corrupts the map silently.

- **`match`** — you are there. Refresh the edge's timestamp:
  `shakedown map set-health --file <map> --from <a> --to <b> --health ok --verified-now`, then continue.
- **`drift`** with `"healed": true` — the screen's signature had rotted and was re-derived and saved as provisional. Continue, and list the edit in your report.
- **`drift`** with `"healed": false` — it refused because every candidate cue looked dynamic. Report it as a testability finding; do not hand-write a signature.
- **`lost`** — you are on the screen named in `actual`, not where you meant to be. Nothing was written. Re-resolve from there (`shakedown map route <target> --from <actual>`) and continue.
- **`unknown`** — the app is somewhere the map has never seen. Dispatch the `shakedown-healer` agent with the failed edge, the platform/device, and the map path. The healer diagnoses (moved target / new intermediate screen / removed feature), fixes the map, and verifies the repair.

If the healer marks the edge broken and no alternative route exists, report exactly which transition died — that is a real finding about the app, not a tooling failure.

Do not capture new screens from here. Adding territory to the map is the explorer's job; say what you saw and offer `/shakedown:map`.

## 4. Report

Confirm arrival with a screenshot (`shakedown ui screenshot`), state route taken, edges re-verified, and any map edits the healer made.
