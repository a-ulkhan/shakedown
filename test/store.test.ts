import { describe, expect, it } from 'vitest'
import { mergeMaps, validateMap, emptyMap } from '../src/map/store.js'
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
