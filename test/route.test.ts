import { describe, expect, it } from 'vitest'
import { resolveRoute, renderRouteReverse } from '../src/map/route.js'
import type { Edge, NavigationMap } from '../src/map/types.js'

function makeMap(edges: Edge[], anchors = ['home']): NavigationMap {
  const screenIds = new Set<string>(anchors)
  for (const edge of edges) {
    screenIds.add(edge.from)
    screenIds.add(edge.to)
  }
  const screens: NavigationMap['screens'] = {}
  for (const id of screenIds) {
    screens[id] = { name: id, signature: [{ kind: 'a11yId', value: `id_${id}` }] }
  }
  return { app: 'com.example.demo', platform: 'ios', schema: 1, anchors, screens, edges }
}

function tapEdge(from: string, to: string, health: Edge['health'] = 'ok'): Edge {
  return { from, to, action: { kind: 'tap', target: { kind: 'a11yId', value: `id_item_${to}` } }, health }
}

describe('resolveRoute', () => {
  it('resolves a linear path from the anchor', () => {
    const map = makeMap([tapEdge('home', 'more_menu'), tapEdge('more_menu', 'loans')])
    const route = resolveRoute(map, 'loans')
    expect(route.start).toBe('home')
    expect(route.steps.map((s) => s.to)).toEqual(['more_menu', 'loans'])
  })

  it('prefers the shortest path when several exist', () => {
    const map = makeMap([
      tapEdge('home', 'more_menu'),
      tapEdge('more_menu', 'settings'),
      tapEdge('settings', 'loans'),
      tapEdge('home', 'loans'),
    ])
    const route = resolveRoute(map, 'loans')
    expect(route.steps).toHaveLength(1)
    expect(route.steps[0]?.from).toBe('home')
  })

  it('never routes over broken edges', () => {
    const map = makeMap([
      tapEdge('home', 'loans', 'broken'),
      tapEdge('home', 'more_menu'),
      tapEdge('more_menu', 'loans'),
    ])
    const route = resolveRoute(map, 'loans')
    expect(route.steps.map((s) => s.to)).toEqual(['more_menu', 'loans'])
  })

  it('uses stale edges but reports a warning', () => {
    const map = makeMap([tapEdge('home', 'loans', 'stale')])
    const route = resolveRoute(map, 'loans')
    expect(route.steps).toHaveLength(1)
    expect(route.warnings).toHaveLength(1)
    expect(route.warnings[0]).toContain('stale')
  })

  it('starts from --from instead of the anchor when given', () => {
    const map = makeMap([
      tapEdge('home', 'more_menu'),
      tapEdge('more_menu', 'loans'),
      tapEdge('loans', 'loan_details'),
    ])
    const route = resolveRoute(map, 'loan_details', 'loans')
    expect(route.start).toBe('loans')
    expect(route.steps).toHaveLength(1)
  })

  it('returns an empty step list when already at the target', () => {
    const map = makeMap([tapEdge('home', 'loans')])
    const route = resolveRoute(map, 'home')
    expect(route.steps).toHaveLength(0)
  })

  it('throws for unreachable screens', () => {
    const map = makeMap([tapEdge('orphan_a', 'orphan_b'), tapEdge('home', 'more_menu')])
    expect(() => resolveRoute(map, 'orphan_b')).toThrow(/no route/)
  })

  it('throws for unknown screens', () => {
    const map = makeMap([tapEdge('home', 'loans')])
    expect(() => resolveRoute(map, 'nonexistent')).toThrow(/unknown screen/)
  })
})

describe('renderRouteReverse', () => {
  it('renders the reverse-dictionary view (target first)', () => {
    const map = makeMap([tapEdge('home', 'more_menu'), tapEdge('more_menu', 'loans')])
    const lines = renderRouteReverse(map, resolveRoute(map, 'loans'))
    expect(lines[0]).toBe('loans: tap "id_item_loans" in more_menu')
    expect(lines[1]).toBe('more_menu: tap "id_item_more_menu" in home')
  })
})
