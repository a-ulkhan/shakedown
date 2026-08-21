# Map self-healing and auto-capture

**Date:** 2026-08-21
**Status:** approved, ready for implementation plan

## Problem

The navigation map drifts as the app changes. Today every repair is manual or
requires an explicit agent dispatch:

- `screen verify` returns pass/fail with no notion of *why* it failed.
- The `shakedown-healer` agent must be dispatched by hand from the `goto` skill.
- New screens enter the map only through an explicit `map capture-current` or a
  full explorer crawl.

We want two behaviours: when a mapped screen's signature has drifted, fix it
automatically; when the app lands somewhere genuinely new, record it.

## The failure mode this design exists to prevent

`screen verify <to>` failing has two causes that are indistinguishable at the
call site but must be handled oppositely:

- **Drift** — we are on the right screen, a label changed. Re-deriving the
  signature is correct.
- **Lost** — navigation went somewhere else entirely. Re-deriving `to`'s
  signature here overwrites *Loans* with the *error dialog's* cues. The map then
  verifies green forever while routing to the wrong place: silent, permanent,
  and invisible in a diff.

A naive "verify fails, therefore update the signature" does exactly the wrong
thing in the second case. Distinguishing them is the core of this design.

## Core insight

`identifyScreen` already ranks the live tree against *every* screen in the map,
so the distinction is available deterministically with no new inference and no
model involvement. We are reading a scorer that already exists.

## A. `src/map/reconcile.ts` — the triage primitive

A new pure module. No I/O, no driver access; it takes a map and a node tree.

```ts
export const DRIFT_FLOOR = 0.3

export type Verdict = 'match' | 'drift' | 'lost' | 'unknown'

export interface Triage {
  verdict: Verdict
  expected: string
  /** the screen we actually appear to be on — only set for 'lost' */
  actual?: string
  /** expected's own score against the live tree */
  score: number
  ranked: ScreenMatch[]
}

export function triage(map: NavigationMap, expected: string, roots: UiNode[]): Triage
```

### Algorithm (ordered; earlier rules win)

1. `verifyScreen(map, expected, roots).ok` → **`match`**.
2. `ranked = identifyScreen(map, roots)`. Let `other` be the highest-scoring
   entry whose id is not `expected`. If `other.score >= VERIFY_THRESHOLD` →
   **`lost`**, with `actual = other.screen`.
3. Let `self` be `ranked`'s entry for `expected`. If
   `self.score >= DRIFT_FLOOR` → **`drift`**.
4. Otherwise → **`unknown`**.

Rule 2 precedes rule 3 deliberately: when the live tree matches both `expected`
weakly and another screen strongly, the safe reading is that we are lost. The
ambiguous case resolves away from mutation.

`DRIFT_FLOOR = 0.3` is exported and tunable. Rationale: below `VERIFY_THRESHOLD`
(0.6), but a screen scoring under 0.3 against its own recorded signature has
almost nothing in common with what was recorded, and re-deriving from that
ground is closer to inventing a new screen than to repairing one.

## B. CLI surface

```
shakedown screen reconcile <expected>
  --platform <ios|android> --device <id>
  [--file <path> | --root <dir> | --store <repo|user>]
  [--heal]
  [--capture <screenId> --name <name>] [--from <screen> --via <spec>]
  [--max-cues <n>] [--no-wait]
```

Emits JSON on stdout:

```json
{ "verdict": "drift", "expected": "loans", "actual": null,
  "score": 0.45, "healed": true, "captured": null }
```

`healed` and `captured` are added by the command; the pure `triage()` function
returns only the verdict fields.

Exit codes, so shell callers can branch without parsing JSON:

- **0** — `match`; `drift` that was successfully healed; `unknown` that was
  successfully captured.
- **1** — everything else: `lost`; `drift` where `--heal` was not passed or the
  heal was refused; `unknown` where `--capture` was not passed or the capture
  was refused.

Reads the screen via `describeStable(driver, device)` unless `--no-wait`, matching
`map capture-current`.

### `--heal` semantics

Acts on **`drift` only**. On `match` it is a no-op; on `lost` and `unknown` it
refuses to write and reports the verdict. This refusal is the safety property
the whole design rests on.

On `drift`:

1. Build `exclude` from every cue belonging to every *other* screen in the map
   (identical to `map capture-current`).
2. `deriveSignature(flattenNodes(roots), { max, exclude })`.
3. If the result is empty, **do not heal** — return `healed: false` with the
   reason. There is no `--force` in the automatic path; a screen with no stable
   cues is a finding, not something to paper over.
4. Otherwise replace `screen.signature`, set `provisional: true`, and save.
   `name` and `notes` are preserved untouched.

### `--capture` semantics

Acts on **`unknown` only**, and only when `--capture` is passed. Reuses the
`map capture-current` code path rather than duplicating it: derive with the
exclude set, refuse when no stable signature emerges, write the screen with
`provisional: true`. When `--from`/`--via` are supplied the resulting edge is
written with `health: 'ok'`, `verified_at: now`, and `provisional: true`.

## C. Schema change

One optional field, added to both `ScreenNode` and `Edge` in `src/map/types.ts`:

```ts
/** Written automatically; not yet blessed by a human. Absent means blessed. */
provisional?: boolean
```

Backward compatible — existing maps load unchanged and `MAP_SCHEMA_VERSION`
stays at 1. Absence means blessed, so every pre-existing entry keeps its current
standing without migration.

`promoteUserMap` in `src/map/store.ts` clears `provisional` on every entry it
moves from the user tier to the repo tier. The existing `~/.shakedown` staging
tier therefore *is* the provisional tier: automatic writes land there, and
`map promote` is the human gate. No second staging mechanism is introduced.

`validateMap` gains no new failure modes; `provisional` is reported, not
enforced.

## D. Wiring per surface

| Surface | Change |
|---|---|
| `goto` | Replace the `screen verify` + `map set-health` pair in step 2 with `screen reconcile --heal`. `drift` → healed, continue, report the edit. `lost` → re-resolve the route from `actual`, no map write. `unknown` → dispatch `shakedown-healer`. |
| `test` / `shakedown-runner` | Same `screen reconcile --heal`, **without** `--capture`. `unknown` → record an `info` step with what was observed, then re-route or stop. The runner's "unknown territory is the explorer's job" contract is preserved exactly. |
| `map` / `shakedown-explorer` | Uses `reconcile --capture`. Separately, the stale hand-derived-cue instruction at `plugin/agents/explorer.md:21` is replaced with `map capture-current`, which has done this deterministically since `0c4cb16`. |
| `doctor` | Reports provisional screens and edges as "awaiting promotion" alongside the existing drift checks. |

Every automatic mutation made during a run is logged through the existing
`shakedown run map-edit`, so the run report remains a complete record of what
the tooling changed.

## E. Healer scope narrows

With drift handled deterministically in the CLI, the `shakedown-healer` agent is
dispatched only for the diagnoses that require live exploration: target
moved/renamed, flow gained an intermediate screen, feature removed. Its
"destination signature changed" branch moves into `reconcile --heal`. Three
diagnoses remain, and they are the sharp ones.

## F. Model tiers (same changeset)

Agent frontmatter currently declares no `model:`, so all four agents inherit the
session model — meaning a Haiku session silently downgrades the visual verifier.
Pin them:

| Agent | `model:` | Rationale |
|---|---|---|
| `shakedown-explorer` | `sonnet` | Every step is score-checked by the CLI; `capture-current` owns cue selection. Highest token volume by a wide margin. |
| `shakedown-runner` | `sonnet` | Follows a given ordered scenario; verdicts come from `screen reconcile` exit codes and `ui find` output; forbidden from judging visuals. |
| `shakedown-healer` | `opus` | Differential diagnosis on ambiguous evidence, and it writes durable state. Fires only on failure, so volume is near zero. |
| `shakedown-verifier` | `opus` | Fine spatial discrimination on images. The only agent with no deterministic backstop — there is no `screen verify` for "is this aligned". |

The governing principle: **model tier tracks how much deterministic backstop the
CLI provides.** `reconcile` adds backstop, which is what makes the explorer and
runner downgrade safe rather than merely cheaper.

## G. Testing

New `test/reconcile.test.ts`, table-driven over synthetic maps and node trees,
following the conventions in `test/signature.test.ts`.

| Case | Assertion |
|---|---|
| expected verifies | `match`, no write |
| expected scores 0.45, no other screen ≥ 0.6 | `drift` |
| expected scores 0.45, another screen scores 0.7 | `lost` — rule 2 beats rule 3 |
| nothing scores ≥ 0.6 | `unknown` |
| **`--heal` on `lost`** | **map is deep-equal before and after** |
| `--heal` on `drift` | signature replaced, `provisional: true`, `name`/`notes` preserved |
| `--heal` on `drift`, no stable cues derivable | refuses, `healed: false`, map unchanged |
| `--heal` twice | second call verdicts `match` and writes nothing |
| `--capture` on `unknown` | screen written `provisional: true`; edge too when `--from`/`--via` given |

Extend `test/store.test.ts`: `promoteUserMap` clears `provisional` on promoted
screens and edges.

## H. Files touched

- new: `src/map/reconcile.ts`, `test/reconcile.test.ts`
- edit: `src/map/types.ts` (one field), `src/map/store.ts` (promotion clears it),
  `src/bin/shakedown.ts` (~30 lines of thin command wiring only)
- edit: `plugin/agents/{explorer,runner,healer,verifier}.md`,
  `plugin/skills/{goto,test,map,doctor}/SKILL.md`

`src/bin/shakedown.ts` is at 958 lines, past the 800-line guideline. All logic
for this feature lives in `src/map/reconcile.ts`; the bin file receives command
wiring only. Splitting it is noted as due but is not part of this work.

## I. Out of scope

- A quarantine namespace — the user/repo tier already provides staging.
- Confidence scores beyond the existing 0–1 signature score.
- Auto-healing of edge *actions* (which target to tap) — that requires
  exploration and stays with the healer agent.
- Auto-promotion of provisional entries.
- A destructive-label guard in `ui tap` — worth doing, tracked separately.
