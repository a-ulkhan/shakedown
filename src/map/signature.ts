import type { UiNode } from '../drivers/types.js'
import type { NavigationMap, SignatureCue } from './types.js'

/**
 * Screen recognition: score the current UI tree against every screen's
 * signature to answer "which screen am I on?".
 *
 * Cue kinds carry different confidence — an accessibility identifier is a far
 * stronger signal than an element type existing somewhere on screen.
 */
const CUE_WEIGHTS: Record<SignatureCue['kind'], number> = {
  a11yId: 1.0,
  label: 0.9,
  text: 0.7,
  type: 0.3,
}

/** A screen counts as verified at or above this normalized score. */
export const VERIFY_THRESHOLD = 0.6

export interface ScreenMatch {
  screen: string
  name: string
  score: number
  matched: SignatureCue[]
  missed: SignatureCue[]
}

export function cueMatches(cue: SignatureCue, node: UiNode): boolean {
  switch (cue.kind) {
    case 'a11yId':
      return node.identifier === cue.value
    case 'label':
      return node.label === cue.value
    case 'text':
      return node.value === cue.value || node.label === cue.value
    case 'type':
      return node.type === cue.value
  }
}

export function flattenNodes(roots: UiNode[]): UiNode[] {
  const nodes: UiNode[] = []
  const visit = (node: UiNode) => {
    nodes.push(node)
    node.children.forEach(visit)
  }
  roots.forEach(visit)
  return nodes
}

export function scoreScreen(
  signature: SignatureCue[],
  nodes: UiNode[]
): { score: number; matched: SignatureCue[]; missed: SignatureCue[] } {
  if (signature.length === 0) return { score: 0, matched: [], missed: [] }
  const matched: SignatureCue[] = []
  const missed: SignatureCue[] = []
  let matchedWeight = 0
  let totalWeight = 0
  for (const cue of signature) {
    const weight = CUE_WEIGHTS[cue.kind]
    totalWeight += weight
    if (nodes.some((node) => cueMatches(cue, node))) {
      matched.push(cue)
      matchedWeight += weight
    } else {
      missed.push(cue)
    }
  }
  return { score: totalWeight > 0 ? matchedWeight / totalWeight : 0, matched, missed }
}

/** Rank all screens in the map by how well the current UI matches them. */
export function identifyScreen(map: NavigationMap, roots: UiNode[]): ScreenMatch[] {
  const nodes = flattenNodes(roots)
  const matches: ScreenMatch[] = []
  for (const [id, screen] of Object.entries(map.screens)) {
    const { score, matched, missed } = scoreScreen(screen.signature, nodes)
    matches.push({ screen: id, name: screen.name, score, matched, missed })
  }
  matches.sort((a, b) => b.score - a.score)
  return matches
}

export interface VerifyResult {
  ok: boolean
  screen: string
  score: number
  matched: SignatureCue[]
  missed: SignatureCue[]
}

// ---------------------------------------------------------------------------
// signature derivation — pick 2-4 distinctive, stable cues from a live tree

/** Generic navigation/action chrome that appears on many screens — never distinctive. */
const CHROME_LABELS = new Set([
  'back', 'cancel', 'done', 'close', 'next', 'continue', 'skip', 'save',
  'ok', 'allow', "don't allow", 'dismiss', 'edit', 'search', 'submit',
])

/** A cue value is dynamic (per-run / per-entity) if it looks like data, not a fixed string. */
export function isDynamicCueValue(value: string): boolean {
  const s = value.trim()
  if (s.length === 0 || s.length > 40) return true
  if (/[₾€$£¥₽]/.test(s)) return true // currency amounts
  if (/[0-9a-f]{12,}/i.test(s)) return true // long hex / uuid / hash ids
  if (/\d{2,}/.test(s)) return true // 2+ consecutive digits: amounts, times, dates
  if (/_\d+(_\d+)*$/.test(s)) return true // indexed identifiers e.g. cell_0_0
  return false
}

function isChrome(cue: SignatureCue): boolean {
  const v = cue.value.toLowerCase()
  if (cue.kind === 'a11yId') return /navigation_button/.test(v) || v.endsWith('_back') || v.endsWith('_close')
  return CHROME_LABELS.has(v)
}

/** The single best cue a node can contribute, strongest kind first, or none if all are dynamic. */
function candidateCue(node: UiNode): SignatureCue | undefined {
  if (node.identifier && !isDynamicCueValue(node.identifier)) return { kind: 'a11yId', value: node.identifier }
  if (node.label && !isDynamicCueValue(node.label)) return { kind: 'label', value: node.label }
  if (node.value && !isDynamicCueValue(node.value)) return { kind: 'text', value: node.value }
  return undefined
}

/**
 * Derive up to `max` stable, distinctive signature cues from a flattened live
 * tree. Skips dynamic-looking values, generic nav chrome, and any cue already
 * used by another screen (pass `exclude` = "kind:value" strings from the rest
 * of the map). Ranks by cue strength (a11yId > label > text), then top-of-screen
 * first as a tie-break. Returns [] when nothing stable survives.
 */
export function deriveSignature(
  nodes: UiNode[],
  options: { max?: number; exclude?: Set<string> } = {}
): SignatureCue[] {
  const max = options.max ?? 3
  const exclude = options.exclude ?? new Set<string>()
  const candidates: Array<{ cue: SignatureCue; y: number }> = []
  for (const node of nodes) {
    const cue = candidateCue(node)
    if (!cue || isChrome(cue)) continue
    if (exclude.has(`${cue.kind}:${cue.value}`)) continue
    candidates.push({ cue, y: node.frame.y })
  }
  candidates.sort((a, b) => {
    const byWeight = CUE_WEIGHTS[b.cue.kind] - CUE_WEIGHTS[a.cue.kind]
    return byWeight !== 0 ? byWeight : a.y - b.y
  })
  const seen = new Set<string>()
  const out: SignatureCue[] = []
  for (const { cue } of candidates) {
    const key = `${cue.kind}:${cue.value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cue)
    if (out.length >= max) break
  }
  return out
}

/** Check whether the current UI matches one specific screen's signature. */
export function verifyScreen(map: NavigationMap, screenId: string, roots: UiNode[]): VerifyResult {
  const screen = map.screens[screenId]
  if (!screen) {
    throw new Error(`unknown screen "${screenId}"`)
  }
  const { score, matched, missed } = scoreScreen(screen.signature, flattenNodes(roots))
  return { ok: score >= VERIFY_THRESHOLD, screen: screenId, score, matched, missed }
}
