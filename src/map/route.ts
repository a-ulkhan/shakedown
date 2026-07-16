import type { NavigationMap, Route, RouteStep } from './types.js'

/**
 * Resolve the shortest path to `target`, starting from `start` (a known
 * current screen) or, when omitted, from the nearest anchor.
 *
 * Edges are stored forward (from → action → to) and queried here; the
 * "reverse dictionary" view ("Loans: tap Loans item in More menu; More menu:
 * last tab on Home") is exactly this resolution, rendered backwards.
 *
 * Broken edges are never used. Stale edges are used but reported as warnings
 * so the runner re-verifies them and heals the map.
 */
export function resolveRoute(map: NavigationMap, target: string, start?: string): Route {
  if (!map.screens[target]) {
    throw new Error(`unknown screen "${target}" — known: ${Object.keys(map.screens).join(', ')}`)
  }
  const starts = start !== undefined ? [start] : map.anchors
  if (starts.length === 0) {
    throw new Error('map has no anchors and no explicit start screen was given')
  }
  for (const startScreen of starts) {
    if (!map.screens[startScreen]) {
      throw new Error(`unknown start screen "${startScreen}"`)
    }
  }

  // multi-source BFS over usable edges
  const usable = map.edges.filter((edge) => edge.health !== 'broken')
  const cameFrom = new Map<string, RouteStep>()
  const visited = new Set<string>(starts)
  let frontier = [...starts]

  while (frontier.length > 0 && !visited.has(target)) {
    const next: string[] = []
    for (const screen of frontier) {
      for (const edge of usable) {
        if (edge.from !== screen || visited.has(edge.to)) continue
        visited.add(edge.to)
        cameFrom.set(edge.to, {
          from: edge.from,
          to: edge.to,
          action: edge.action,
          health: edge.health,
        })
        next.push(edge.to)
      }
    }
    frontier = next
  }

  if (!visited.has(target) && !starts.includes(target)) {
    throw new Error(
      `no route to "${target}" from ${starts.join(', ')} — the map may be incomplete or edges are broken`
    )
  }

  const steps: RouteStep[] = []
  let cursor = target
  while (!starts.includes(cursor)) {
    const step = cameFrom.get(cursor)
    if (!step) break
    steps.unshift(step)
    cursor = step.from
  }

  const warnings = steps
    .filter((step) => step.health === 'stale')
    .map((step) => `edge ${step.from} → ${step.to} is stale; verify and re-record it`)

  return { target, start: cursor, steps, warnings }
}

/** Human rendering, in the user's "reverse dictionary" style. */
export function renderRouteReverse(map: NavigationMap, route: Route): string[] {
  const lines: string[] = []
  for (let i = route.steps.length - 1; i >= 0; i -= 1) {
    const step = route.steps[i]
    if (!step) continue
    const toName = map.screens[step.to]?.name ?? step.to
    const fromName = map.screens[step.from]?.name ?? step.from
    lines.push(`${toName}: ${describeAction(step)} in ${fromName}`)
  }
  return lines
}

function describeAction(step: RouteStep): string {
  const target = step.action.target
  const targetText = target ? `"${target.value}"` : ''
  switch (step.action.kind) {
    case 'tap':
      return `tap ${targetText}`.trim()
    case 'swipe':
      return `swipe ${step.action.argument ?? ''}`.trim()
    case 'type':
      return `type into ${targetText}`.trim()
    case 'launch':
      return 'launch the app'
  }
}
