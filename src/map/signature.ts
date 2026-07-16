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

/** Check whether the current UI matches one specific screen's signature. */
export function verifyScreen(map: NavigationMap, screenId: string, roots: UiNode[]): VerifyResult {
  const screen = map.screens[screenId]
  if (!screen) {
    throw new Error(`unknown screen "${screenId}"`)
  }
  const { score, matched, missed } = scoreScreen(screen.signature, flattenNodes(roots))
  return { ok: score >= VERIFY_THRESHOLD, screen: screenId, score, matched, missed }
}
