import { describe, expect, it } from 'vitest'
import { mergeInto, mergeMaps, parseVia, validateMap, emptyMap } from '../src/map/store.js'
import type { NavigationMap } from '../src/map/types.js'

function baseMap(platform: NavigationMap['platform']): NavigationMap {
  return {
    ...emptyMap('com.example.demo', platform),
    anchors: ['home'],
    screens: {
      home: { name: 'Home', signature: [{ kind: 'a11yId', value: 'id_home' }] },
    },
  }
}

describe('mergeMaps', () => {
  it('platform screens override shared screens with the same id', () => {
    const shared = baseMap('shared')
    shared.screens.loans = { name: 'Loans (shared)', signature: [{ kind: 'label', value: 'Loans' }] }
    const ios = baseMap('ios')
    ios.screens.loans = { name: 'Loans (iOS)', signature: [{ kind: 'a11yId', value: 'id_loans' }] }

    const merged = mergeMaps(shared, ios)
    expect(merged.screens.loans?.name).toBe('Loans (iOS)')
    expect(merged.platform).toBe('ios')
  })

  it('platform edges override shared edges for the same (from, to, action kind)', () => {
    const shared = baseMap('shared')
    shared.screens.loans = { name: 'Loans', signature: [] }
    shared.edges.push({
      from: 'home', to: 'loans',
      action: { kind: 'tap', target: { kind: 'label', value: 'Loans (shared label)' } },
      health: 'ok',
    })
    const android = baseMap('android')
    android.screens.loans = { name: 'Loans', signature: [] }
    android.edges.push({
      from: 'home', to: 'loans',
      action: { kind: 'tap', target: { kind: 'a11yId', value: 'id_loans_item' } },
      health: 'ok',
    })

    const merged = mergeMaps(shared, android)
    expect(merged.edges).toHaveLength(1)
    expect(merged.edges[0]?.action.target?.value).toBe('id_loans_item')
  })

  it('keeps shared edges that the platform map does not override', () => {
    const shared = baseMap('shared')
    shared.screens.settings = { name: 'Settings', signature: [] }
    shared.edges.push({ from: 'home', to: 'settings', action: { kind: 'tap' }, health: 'ok' })
    const ios = baseMap('ios')

    const merged = mergeMaps(shared, ios)
    expect(merged.edges).toHaveLength(1)
    expect(merged.screens.settings).toBeDefined()
  })
})

describe('mergeInto', () => {
  it('unions anchors and screens and dedups anchors', () => {
    const map = baseMap('ios')
    mergeInto(map, {
      anchors: ['home', 'loans'],
      screens: { loans: { name: 'Loans', signature: [{ kind: 'label', value: 'Loans' }] } },
    })
    expect(map.anchors).toEqual(['home', 'loans'])
    expect(map.screens.loans).toBeDefined()
  })

  it('overwrites an edge with the same (from, to, action kind) instead of duplicating', () => {
    const map = baseMap('ios')
    map.screens.loans = { name: 'Loans', signature: [] }
    map.edges.push({ from: 'home', to: 'loans', action: { kind: 'tap', target: { kind: 'label', value: 'old' } }, health: 'stale' })
    mergeInto(map, {
      edges: [{ from: 'home', to: 'loans', action: { kind: 'tap', target: { kind: 'label', value: 'new' } }, health: 'ok' }],
    })
    expect(map.edges).toHaveLength(1)
    expect(map.edges[0]?.health).toBe('ok')
    expect(map.edges[0]?.action.target?.value).toBe('new')
  })

  it('appends an edge that differs by action kind', () => {
    const map = baseMap('ios')
    map.screens.loans = { name: 'Loans', signature: [] }
    map.edges.push({ from: 'home', to: 'loans', action: { kind: 'tap' }, health: 'ok' })
    mergeInto(map, { edges: [{ from: 'home', to: 'loans', action: { kind: 'swipe', argument: 'up' }, health: 'ok' }] })
    expect(map.edges).toHaveLength(2)
  })
})

describe('parseVia', () => {
  it('parses tap targets (bare id, id=, label=, text=)', () => {
    expect(parseVia('tap:id_button_x')).toEqual({ kind: 'tap', target: { kind: 'a11yId', value: 'id_button_x' } })
    expect(parseVia('tap:id=id_x')).toEqual({ kind: 'tap', target: { kind: 'a11yId', value: 'id_x' } })
    expect(parseVia('tap:label=New transfer')).toEqual({ kind: 'tap', target: { kind: 'label', value: 'New transfer' } })
    expect(parseVia('tap:text=Continue')).toEqual({ kind: 'tap', target: { kind: 'text', value: 'Continue' } })
  })

  it('parses swipe directions and type', () => {
    expect(parseVia('swipe:down')).toEqual({ kind: 'swipe', argument: 'down' })
    expect(parseVia('type:010203')).toEqual({ kind: 'type', argument: '010203' })
  })

  it('throws on garbage and bad directions', () => {
    expect(() => parseVia('tap:')).toThrow()
    expect(() => parseVia('swipe:sideways')).toThrow()
    expect(() => parseVia('frobnicate:x')).toThrow(/unknown --via kind/)
  })
})

describe('validateMap', () => {
  it('flags edges referencing undefined screens as errors', () => {
    const map = baseMap('ios')
    map.edges.push({ from: 'home', to: 'ghost', action: { kind: 'tap' }, health: 'ok' })
    const issues = validateMap(map)
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('ghost'))).toBe(true)
  })

  it('flags unreachable screens as warnings', () => {
    const map = baseMap('ios')
    map.screens.island = { name: 'Island', signature: [{ kind: 'label', value: 'X' }] }
    const issues = validateMap(map)
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('island'))).toBe(true)
  })

  it('treats screens reachable only via broken edges as unreachable', () => {
    const map = baseMap('ios')
    map.screens.loans = { name: 'Loans', signature: [{ kind: 'label', value: 'Loans' }] }
    map.edges.push({ from: 'home', to: 'loans', action: { kind: 'tap' }, health: 'broken' })
    const issues = validateMap(map)
    expect(issues.some((i) => i.message.includes('loans') && i.message.includes('unreachable'))).toBe(true)
  })

  it('passes a healthy map', () => {
    const map = baseMap('ios')
    map.screens.loans = { name: 'Loans', signature: [{ kind: 'label', value: 'Loans' }] }
    map.edges.push({ from: 'home', to: 'loans', action: { kind: 'tap' }, health: 'ok' })
    expect(validateMap(map)).toHaveLength(0)
  })
})
