import type { UiNode } from '../drivers/types.js'
import {
  deriveSignature,
  flattenNodes,
  identifyScreen,
  verifyScreen,
  VERIFY_THRESHOLD,
  type ScreenMatch,
} from './signature.js'
import type { PartialMap } from './store.js'
import type { Edge, EdgeAction, NavigationMap, ScreenNode, SignatureCue } from './types.js'

/**
 * Reconciliation: deciding *why* `screen verify` failed, and what may safely be
 * written to the map as a result.
 *
 * A failed verify has two causes that look identical at the call site and must
 * be handled oppositely. Either we are on the right screen and a cue changed
 * (drift — repair it), or navigation went somewhere unintended (lost — repairing
 * here would overwrite this screen's signature with a different screen's cues,
 * leaving a map that verifies green forever while routing to the wrong place).
 *
 * Telling them apart needs no new inference: `identifyScreen` already ranks the
 * live tree against every screen in the map.
 */

/**
 * A screen scoring below this against its own recorded signature has almost
 * nothing left in common with what was recorded — re-deriving from that ground
 * is closer to inventing a new screen than repairing one. The band between this
 * and VERIFY_THRESHOLD is what we call drift and repair automatically.
 */
export const DRIFT_FLOOR = 0.3

export type Verdict = 'match' | 'drift' | 'lost' | 'unknown'

export interface Triage {
  verdict: Verdict
  expected: string
  /** The screen we actually appear to be on. Only set for 'lost'. */
  actual?: string
  /** How well the live tree matches `expected`'s own signature. */
  score: number
  ranked: ScreenMatch[]
}

/** Classify the live screen against what we expected to be looking at. */
export function triage(map: NavigationMap, expected: string, roots: UiNode[]): Triage {
  if (!map.screens[expected]) {
    throw new Error(`unknown screen "${expected}" — known: ${Object.keys(map.screens).join(', ')}`)
  }
  const ranked = identifyScreen(map, roots)
  const score = ranked.find((match) => match.screen === expected)?.score ?? 0

  if (verifyScreen(map, expected, roots).ok) {
    return { verdict: 'match', expected, score, ranked }
  }

  // Rule order is load-bearing: a strong match on some OTHER screen is checked
  // before a weak match on the expected one. When both readings are available
  // the ambiguity must resolve away from mutation.
  const other = ranked.find((match) => match.screen !== expected)
  if (other && other.score >= VERIFY_THRESHOLD) {
    return { verdict: 'lost', expected, actual: other.screen, score, ranked }
  }
  if (score >= DRIFT_FLOOR) {
    return { verdict: 'drift', expected, score, ranked }
  }
  return { verdict: 'unknown', expected, score, ranked }
}

/**
 * A proposed map write. Plans are pure values — nothing is persisted until the
 * caller merges the partial and saves.
 */
export type Plan =
  | { ok: true; partial: PartialMap; signature: SignatureCue[] }
  | { ok: false; reason: string }

const NO_STABLE_SIGNATURE =
  'no stable signature could be derived (every candidate cue looked dynamic)'

/** Every cue already claimed by some other screen, so a repair cannot steal one. */
export function excludeCuesFor(map: NavigationMap, screenId: string): Set<string> {
  const exclude = new Set<string>()
  for (const [id, screen] of Object.entries(map.screens)) {
    if (id === screenId) continue
    for (const cue of screen.signature) exclude.add(`${cue.kind}:${cue.value}`)
  }
  return exclude
}

/**
 * Re-derive a drifted screen's signature from the live tree. Only ever valid on
 * a 'drift' verdict — callers must not apply this to 'lost' or 'unknown'.
 *
 * There is deliberately no force option: a screen with no stable cues is a real
 * finding about the app's testability, not something to paper over.
 */
export function planHeal(
  map: NavigationMap,
  expected: string,
  roots: UiNode[],
  options: { maxCues?: number } = {}
): Plan {
  const current = map.screens[expected]
  if (!current) {
    throw new Error(`unknown screen "${expected}" — known: ${Object.keys(map.screens).join(', ')}`)
  }
  const signature = deriveSignature(flattenNodes(roots), {
    max: options.maxCues ?? 3,
    exclude: excludeCuesFor(map, expected),
  })
  if (signature.length === 0) return { ok: false, reason: NO_STABLE_SIGNATURE }

  // Spread `current` so the human-authored name and notes survive the repair.
  const screen: ScreenNode = { ...current, signature, provisional: true }
  return { ok: true, partial: { screens: { [expected]: screen } }, signature }
}

export interface CaptureOptions {
  name: string
  maxCues?: number
  /** Source screen of the edge that led here; requires `via`. */
  from?: string
  /** Action that led here; requires `from`. */
  via?: EdgeAction
  anchor?: boolean
  notes?: string
  /**
   * Mark the write as machine-origin. Defaults to true: `reconcile --capture`
   * fires as a side effect of navigating somewhere else, which is exactly the
   * kind of write a human should review. Deliberate mapping via
   * `map capture-current` passes false.
   */
  provisional?: boolean
  /** Human escape hatch: save even with no stable signature. Never set by the automatic path. */
  force?: boolean
  /** Injectable clock, so captures are reproducible under test. */
  now?: string
}

/** Record a screen that is not in the map yet. Only valid on an 'unknown' verdict. */
export function planCapture(
  map: NavigationMap,
  screenId: string,
  roots: UiNode[],
  options: CaptureOptions
): Plan {
  if ((options.from && !options.via) || (!options.from && options.via)) {
    throw new Error('a captured edge needs both a source screen and an action')
  }
  const signature = deriveSignature(flattenNodes(roots), {
    max: options.maxCues ?? 3,
    exclude: excludeCuesFor(map, screenId),
  })
  if (signature.length === 0 && options.force !== true) {
    return { ok: false, reason: NO_STABLE_SIGNATURE }
  }

  const provisional = options.provisional ?? true
  const screen: ScreenNode = {
    name: options.name,
    signature,
    ...(options.notes ? { notes: options.notes } : {}),
    ...(provisional && { provisional: true }),
  }
  const edges: Edge[] =
    options.from && options.via
      ? [
          {
            from: options.from,
            to: screenId,
            action: options.via,
            health: 'ok',
            verified_at: options.now ?? new Date().toISOString(),
            ...(provisional && { provisional: true }),
          },
        ]
      : []

  return {
    ok: true,
    partial: {
      screens: { [screenId]: screen },
      ...(edges.length > 0 && { edges }),
      ...(options.anchor === true && { anchors: [screenId] }),
    },
    signature,
  }
}
