---
name: doctor
description: Health-check the navigation map against the current build — re-verify edges on a live device, report and repair drift. Use for "check the map", "is the map still valid", after big app changes, or periodically in CI-like routines.
---

# shakedown doctor

Re-verify the navigation map against the app as it is today.

## 1. Static pass (cheap, no device)

```bash
shakedown map validate --file "$(shakedown map path --platform <p>)"
```

Fix structural errors first (dangling edges, unreachable screens) — walking a structurally broken map wastes device time.

## 2. Live pass

Precondition: booted device, current build installed and launched.

Walk the map from its anchors breadth-first (the order `shakedown map route` would use):

1. For each edge in BFS order, navigate to `from` (you are usually already there by construction), perform the edge action, then `shakedown screen reconcile <to> --platform <p> --device <d> --heal`.
2. `match` → `shakedown map set-health ... --health ok --verified-now --app-version <version>`.
3. `drift` → the signature was re-derived and saved as provisional; count it as drift repaired.
4. `lost` or `unknown` → dispatch the `shakedown-healer` for that edge; count it as drift needing diagnosis.

Budget: for large maps, ask the user whether to check everything or only edges older than N days (`verified_at` in the map file tells you).

## 3. Report

Drift summary for the user:

- edges re-verified OK / auto-healed / repaired by the healer / marked broken
- screens whose signatures were updated
- **entries still marked `provisional`** — everything shakedown wrote on its own and no human has blessed yet. Surface the count and offer `shakedown map promote` when they look right; promotion clears the flag.
- a one-line diff hint: `git diff .shakedown/maps/` shows exactly what the doctor changed

Suggest committing the updated map when the working tree is otherwise clean.
