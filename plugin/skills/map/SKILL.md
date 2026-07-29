---
name: map
description: Explore the app and record screens/transitions into the navigation map. Use for "map the app", "map the Loans screen", "explore the app", or when goto/test report unmapped screens. Supports targeted mapping and full-app crawls.
---

# shakedown map

Build or extend the navigation map by exploring the live app. The map lives at `.shakedown/maps/<platform>.map.json` by default, or in the user-level store (`~/.shakedown/maps/<appId>/`) when `mapStore: "user"` is set in `.shakedown/config.local.json` — always resolve the file with `shakedown map path --platform <p>` instead of hardcoding it.

## 0. Preconditions

- App profile exists (else run `/shakedown:setup` first).
- A device is booted with the current build installed: `shakedown devices`, then `shakedown boot` / `app install` / `app launch` as needed.
- Load the current map state: `shakedown map show --platform <p>` (a missing map is fine — exploration creates it).

## 1. Scope the exploration

Two modes, from the user's request:

- **Targeted** ("map the Loans screen"): find the shortest unexplored path to one screen. Cheap, minutes.
- **Full crawl** (`--full` / "map the entire app"): breadth-first over every reachable screen. This can take a long time and taps everything non-destructive. ALWAYS confirm with the user before a full crawl, and agree on a step budget (default 150 actions).

## 2. Dispatch the explorer

Dispatch the `shakedown-explorer` agent with: platform, device id, app id, repo root, current map summary, the scope, and the step budget. For a full crawl on a large app, dispatch sequential explorer rounds (each resuming from the saved map + remaining frontier) rather than one giant session — the map on disk is the shared state between rounds.

The explorer saves incrementally via `shakedown map upsert`, so partial progress is never lost.

## 3. Anchors and launch state

Ensure at least one anchor exists: the screen the app lands on after `shakedown app launch`. If the map has no anchors, identify the launch screen and record it in the map's `anchors` array (via `map upsert`).

## 4. Wrap up

- Validate: `shakedown map validate --file "$(shakedown map path --platform <p>)"`
- Report to the user: screens/edges added, remaining frontier (what a future round would explore), any screens the explorer avoided (destructive elements) and why.
- If the platforms share UX, note candidate screens for `shared.map.json` — but only move entries there when both platform maps agree.
- Remind the user the map is committable: reviewing the diff of the map file is how the team audits what the explorer learned.
