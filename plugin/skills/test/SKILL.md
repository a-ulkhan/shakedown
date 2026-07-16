---
name: test
description: Run a manual test scenario on the app — navigate, act, verify (accessibility + visual), and produce evidence (screenshots, recording, report). Use for "test that X", "verify the ticket scenario", "run this manual test case", or a pasted test-case/AC list.
---

# shakedown test

Execute a manual test case end to end and hand back evidence a reviewer can trust.

## 1. Frame the scenario

Turn the user's request (prose, ticket ACs, a test-case list) into ordered steps, each with:
- **action** — something the runner can do (navigate to screen X, tap Y, type Z)
- **expected** — something checkable, classified as:
  - `structural` — element exists / label text / screen reached (accessibility tree answers it)
  - `visual` — alignment, layout, theming, rendering (only a screenshot answers it)

Echo the framed steps to the user before running if the mapping from their words was non-obvious.

## 2. Prepare

- Fresh state when the scenario needs it: `shakedown terminate` + `app launch`.
- Start the evidence session and recording:

```bash
shakedown run start --name "<scenario name>" --platform <p> --device <d>     # → run dir
shakedown ui record start --platform <p> --device <d> --out <run-dir>/recording.mp4
```

- Resolve the route to the starting screen: `shakedown map route <screen> --platform <p>`. Unmapped screens → offer `/shakedown:map` first.

## 3. Execute

Dispatch the `shakedown-runner` agent with: platform, device, app id, repo root, run dir, the framed steps, and the resolved route. The runner acts, checks structural expectations itself, screenshots every meaningful step into the run dir, and records step outcomes. Navigation failures mid-run go through the `shakedown-healer` (the runner marks the edge and reports; dispatch the healer, then let the runner resume).

## 4. Visual verification

After the runner returns, if any expectations were `visual`: dispatch the `shakedown-verifier` agent with the run dir and the expectation-to-screenshot list. It records pass/fail verdicts into the run.

## 5. Close and report

```bash
shakedown ui record stop --platform <p> --device <d>
shakedown run finish --dir <run-dir> --status pass|fail --summary "..." --recording <run-dir>/recording.mp4
```

Overall status: `fail` if any step failed; `pass` only when every expectation was checked and passed.

Report to the user: per-step outcomes, the run directory path, recording path, and any map edits made by self-healing. Never soften a failure — a red step with a screenshot is the tool doing its job.
