import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Platform } from '../drivers/types.js'
import { MAP_SCHEMA_VERSION, type Edge, type EdgeAction, type NavigationMap, type ScreenNode } from './types.js'

/**
 * Maps live inside the app repo by default (committable, team-shareable):
 *   .shakedown/maps/<platform>.map.json   — platform-specific
 *   .shakedown/maps/shared.map.json       — cross-platform overlay (optional)
 * Platform entries win over shared entries on conflict.
 */
export function defaultMapPath(rootDir: string, platform: Platform | 'shared'): string {
  return join(rootDir, '.shakedown', 'maps', `${platform}.map.json`)
}

export function emptyMap(app: string, platform: Platform | 'shared'): NavigationMap {
  return {
    app,
    platform,
    schema: MAP_SCHEMA_VERSION,
    anchors: [],
    screens: {},
    edges: [],
  }
}

export async function loadMap(path: string): Promise<NavigationMap> {
  const raw = await readFile(path, 'utf-8')
  const map = JSON.parse(raw) as NavigationMap
  if (map.schema !== MAP_SCHEMA_VERSION) {
    throw new Error(
      `${path} uses map schema v${map.schema}; this build of shakedown supports v${MAP_SCHEMA_VERSION}`
    )
  }
  return map
}

export async function saveMap(path: string, map: NavigationMap): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(map, null, 2)}\n`, 'utf-8')
}

export interface PartialMap {
  anchors?: string[]
  screens?: Record<string, ScreenNode>
  edges?: Edge[]
}

/**
 * Merge a partial map into `current` IN PLACE (mutates, matching `map upsert`'s
 * historical behavior): anchors and screens are unioned; edges are keyed by
 * (from, to, action.kind) so re-capturing an edge overwrites rather than dups.
 * Returns `current` for convenience.
 */
export function mergeInto(current: NavigationMap, partial: PartialMap): NavigationMap {
  current.anchors = [...new Set([...current.anchors, ...(partial.anchors ?? [])])]
  Object.assign(current.screens, partial.screens ?? {})
  for (const edge of partial.edges ?? []) {
    const index = current.edges.findIndex(
      (existing) =>
        existing.from === edge.from &&
        existing.to === edge.to &&
        existing.action.kind === edge.action.kind
    )
    if (index >= 0) current.edges[index] = edge
    else current.edges.push(edge)
  }
  return current
}

/**
 * Parse an edge action shorthand for the CLI:
 *   tap:<id> | tap:id=<id> | tap:label=<text> | tap:text=<text>
 *   swipe:up|down|left|right
 *   type:<text>
 */
export function parseVia(spec: string): EdgeAction {
  const sep = spec.indexOf(':')
  const kind = (sep >= 0 ? spec.slice(0, sep) : spec).trim()
  const arg = sep >= 0 ? spec.slice(sep + 1) : ''
  switch (kind) {
    case 'tap': {
      if (!arg) throw new Error('--via tap needs a target, e.g. tap:id_button_x or tap:label=Foo')
      if (arg.startsWith('label=')) return { kind: 'tap', target: { kind: 'label', value: arg.slice(6) } }
      if (arg.startsWith('text=')) return { kind: 'tap', target: { kind: 'text', value: arg.slice(5) } }
      if (arg.startsWith('id=')) return { kind: 'tap', target: { kind: 'a11yId', value: arg.slice(3) } }
      return { kind: 'tap', target: { kind: 'a11yId', value: arg } }
    }
    case 'swipe':
      if (!['up', 'down', 'left', 'right'].includes(arg)) {
        throw new Error('--via swipe needs a direction: swipe:up|down|left|right')
      }
      return { kind: 'swipe', argument: arg }
    case 'type':
      return { kind: 'type', argument: arg }
    default:
      throw new Error(`unknown --via kind "${kind}" (expected tap, swipe, or type)`)
  }
}

/**
 * Load the effective map for a platform: shared overlay merged with the
 * platform map. Platform screens override shared screens with the same id;
 * platform edges override shared edges with the same (from, to, action kind).
 */
export async function loadEffectiveMap(
  rootDir: string,
  platform: Platform
): Promise<NavigationMap> {
  const sharedPath = defaultMapPath(rootDir, 'shared')
  const platformPath = defaultMapPath(rootDir, platform)

  const shared = existsSync(sharedPath) ? await loadMap(sharedPath) : undefined
  const platformMap = existsSync(platformPath) ? await loadMap(platformPath) : undefined
  if (!shared && !platformMap) {
    throw new Error(
      `no map found for ${platform} under ${join(rootDir, '.shakedown', 'maps')} — run mapping first`
    )
  }
  if (!shared) return platformMap as NavigationMap
  if (!platformMap) return { ...shared, platform }

  return mergeMaps(shared, platformMap)
}

export function mergeMaps(shared: NavigationMap, platform: NavigationMap): NavigationMap {
  const screens: Record<string, ScreenNode> = { ...shared.screens, ...platform.screens }
  const edges: Edge[] = [...platform.edges]
  for (const sharedEdge of shared.edges) {
    const overridden = platform.edges.some(
      (edge) =>
        edge.from === sharedEdge.from &&
        edge.to === sharedEdge.to &&
        edge.action.kind === sharedEdge.action.kind
    )
    if (!overridden) edges.push(sharedEdge)
  }
  return {
    app: platform.app || shared.app,
    platform: platform.platform,
    schema: MAP_SCHEMA_VERSION,
    anchors: [...new Set([...shared.anchors, ...platform.anchors])],
    screens,
    edges,
  }
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
}

export function validateMap(map: NavigationMap): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const screenIds = new Set(Object.keys(map.screens))

  for (const anchor of map.anchors) {
    if (!screenIds.has(anchor)) {
      issues.push({ severity: 'error', message: `anchor "${anchor}" is not a defined screen` })
    }
  }
  for (const edge of map.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!screenIds.has(endpoint)) {
        issues.push({
          severity: 'error',
          message: `edge ${edge.from} → ${edge.to} references undefined screen "${endpoint}"`,
        })
      }
    }
  }
  for (const [id, screen] of Object.entries(map.screens)) {
    if (screen.signature.length === 0) {
      issues.push({ severity: 'warning', message: `screen "${id}" has no signature cues` })
    }
  }

  // reachability from anchors over non-broken edges
  const reachable = new Set(map.anchors.filter((anchor) => screenIds.has(anchor)))
  let grew = true
  while (grew) {
    grew = false
    for (const edge of map.edges) {
      if (edge.health !== 'broken' && reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to)
        grew = true
      }
    }
  }
  for (const id of screenIds) {
    if (!reachable.has(id)) {
      issues.push({ severity: 'warning', message: `screen "${id}" is unreachable from anchors` })
    }
  }
  return issues
}
