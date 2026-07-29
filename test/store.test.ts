import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultMapPath,
  emptyMap,
  loadEffectiveMap,
  loadMap,
  mapTierPaths,
  mergeInto,
  mergeMaps,
  parseVia,
  promoteUserMap,
  saveMap,
  userMapPath,
  validateMap,
} from '../src/map/store.js'
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

describe('user-level store', () => {
  const APP = 'com.example.demo'
  let root: string
  let home: string
  let savedHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shakedown-root-'))
    home = await mkdtemp(join(tmpdir(), 'shakedown-home-'))
    savedHome = process.env.SHAKEDOWN_HOME
    process.env.SHAKEDOWN_HOME = home
  })

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.SHAKEDOWN_HOME
    else process.env.SHAKEDOWN_HOME = savedHome
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  it('userMapPath keys by appId under SHAKEDOWN_HOME', () => {
    expect(userMapPath(APP, 'ios')).toBe(join(home, 'maps', APP, 'ios.map.json'))
  })

  it('mapTierPaths orders repo shared → repo platform → user shared → user platform', () => {
    expect(mapTierPaths(root, 'ios', APP)).toEqual([
      defaultMapPath(root, 'shared'),
      defaultMapPath(root, 'ios'),
      userMapPath(APP, 'shared'),
      userMapPath(APP, 'ios'),
    ])
    expect(mapTierPaths(root, 'ios')).toHaveLength(2) // no appId → no user tiers
  })

  it('loadEffectiveMap merges the user tier on top of the repo tier (user wins)', async () => {
    const repo = baseMap('ios')
    repo.screens.loans = { name: 'Loans (repo)', signature: [{ kind: 'label', value: 'Loans' }] }
    await saveMap(defaultMapPath(root, 'ios'), repo)

    const user = emptyMap(APP, 'ios')
    user.screens.loans = { name: 'Loans (user)', signature: [{ kind: 'a11yId', value: 'id_loans' }] }
    user.screens.transfers = { name: 'Transfers', signature: [{ kind: 'label', value: 'Transfers' }] }
    await saveMap(userMapPath(APP, 'ios'), user)

    const merged = await loadEffectiveMap(root, 'ios', APP)
    expect(merged.screens.loans?.name).toBe('Loans (user)')
    expect(merged.screens.transfers).toBeDefined()
    expect(merged.screens.home).toBeDefined() // repo-only screen survives
    expect(merged.platform).toBe('ios')
  })

  it('loadEffectiveMap works with only a user-level map', async () => {
    await saveMap(userMapPath(APP, 'ios'), baseMap('ios'))
    const merged = await loadEffectiveMap(root, 'ios', APP)
    expect(merged.screens.home).toBeDefined()
  })

  it('loadEffectiveMap lists both stores in the not-found error when appId is known', async () => {
    await expect(loadEffectiveMap(root, 'ios', APP)).rejects.toThrow(/\.shakedown.*or.*maps/)
  })

  it('promoteUserMap merges into the repo map and removes the user copy', async () => {
    const repo = baseMap('ios')
    await saveMap(defaultMapPath(root, 'ios'), repo)

    const user = emptyMap(APP, 'ios')
    user.screens.loans = { name: 'Loans', signature: [{ kind: 'label', value: 'Loans' }] }
    user.edges.push({ from: 'home', to: 'loans', action: { kind: 'tap' }, health: 'ok' })
    await saveMap(userMapPath(APP, 'ios'), user)

    const result = await promoteUserMap(root, 'ios', APP)
    expect(result.screensAdded).toBe(1)
    expect(result.edgesAdded).toBe(1)
    expect(result.removedUserCopy).toBe(true)
    expect(existsSync(userMapPath(APP, 'ios'))).toBe(false)

    const promoted = await loadMap(defaultMapPath(root, 'ios'))
    expect(promoted.screens.loans).toBeDefined()
    expect(promoted.screens.home).toBeDefined()
  })

  it('promoteUserMap creates the repo map when missing and honors --keep', async () => {
    await saveMap(userMapPath(APP, 'ios'), baseMap('ios'))
    const result = await promoteUserMap(root, 'ios', APP, { keep: true })
    expect(result.removedUserCopy).toBe(false)
    expect(existsSync(userMapPath(APP, 'ios'))).toBe(true)
    expect((await loadMap(defaultMapPath(root, 'ios'))).screens.home).toBeDefined()
  })

  it('promoteUserMap throws when there is no user map', async () => {
    await expect(promoteUserMap(root, 'ios', APP)).rejects.toThrow(/nothing to promote/)
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
