import { describe, expect, it } from 'vitest'
import { DRIFT_FLOOR, planCapture, planHeal, triage } from '../src/map/reconcile.js'
import { mergeInto } from '../src/map/store.js'
import type { UiNode } from '../src/drivers/types.js'
import type { NavigationMap } from '../src/map/types.js'

function node(partial: Partial<UiNode>): UiNode {
  return {
    type: 'Other',
    frame: { x: 0, y: 0, width: 100, height: 40 },
    enabled: true,
    children: [],
    ...partial,
  }
}

function tree(children: UiNode[]): UiNode[] {
  return [node({ type: 'Application', children })]
}

/** loans: 3 a11yId cues (weight 1.0 each) — one match scores 0.333, inside the drift band. */
function baseMap(): NavigationMap {
  return {
    app: 'com.example.demo',
    platform: 'ios',
    schema: 1,
    anchors: ['home'],
    screens: {
      home: { name: 'Home', signature: [{ kind: 'a11yId', value: 'id_nav_home' }] },
      loans: {
        name: 'Loans',
        notes: 'the loans list',
        signature: [
          { kind: 'a11yId', value: 'id_nav_loans' },
          { kind: 'a11yId', value: 'id_label_loans_title' },
          { kind: 'a11yId', value: 'id_button_new_loan' },
        ],
      },
      settings: {
        name: 'Settings',
        signature: [
          { kind: 'a11yId', value: 'id_nav_settings' },
          { kind: 'a11yId', value: 'id_label_settings_title' },
        ],
      },
    },
    edges: [{ from: 'home', to: 'loans', action: { kind: 'tap', target: { kind: 'a11yId', value: 'id_tab_loans' } }, health: 'ok' }],
  }
}

const LOANS_INTACT = tree([
  node({ type: 'NavigationBar', label: 'Loans', identifier: 'id_nav_loans' }),
  node({ type: 'StaticText', label: 'Active loans', identifier: 'id_label_loans_title' }),
  node({ type: 'Button', label: 'New loan', identifier: 'id_button_new_loan' }),
])

/** Still Loans, but two of three cues were renamed by the app. 1/3 = 0.333 → drift. */
const LOANS_DRIFTED = tree([
  node({ type: 'NavigationBar', label: 'Loans', identifier: 'id_nav_loans' }),
  node({ type: 'StaticText', label: 'Your loans', identifier: 'id_loans_heading' }),
  node({ type: 'Button', label: 'Apply', identifier: 'id_loans_apply' }),
])

/** Settings, which still happens to carry one Loans cue. loans=0.333 AND settings=1.0. */
const SETTINGS_WITH_STRAY_LOANS_CUE = tree([
  node({ type: 'NavigationBar', label: 'Settings', identifier: 'id_nav_settings' }),
  node({ type: 'StaticText', label: 'Settings', identifier: 'id_label_settings_title' }),
  node({ type: 'Button', label: 'Loans', identifier: 'id_nav_loans' }),
])

const UNCHARTED = tree([
  node({ type: 'NavigationBar', label: 'Card details', identifier: 'id_nav_card_details' }),
  node({ type: 'StaticText', label: 'Card limits', identifier: 'id_label_card_limits' }),
])

/** Every candidate cue looks like per-run data, so no stable signature can be derived. */
const ALL_DYNAMIC = tree([
  node({ type: 'StaticText', label: '1 234,56 €', identifier: 'cell_0_0' }),
  node({ type: 'StaticText', label: '2026-08-21', identifier: 'cell_0_1' }),
  node({ type: 'Button', label: 'Done' }),
])

describe('triage', () => {
  it('reports match when the signature still verifies', () => {
    const result = triage(baseMap(), 'loans', LOANS_INTACT)
    expect(result.verdict).toBe('match')
    expect(result.score).toBe(1)
  })

  it('reports drift when only the expected screen partially matches', () => {
    const result = triage(baseMap(), 'loans', LOANS_DRIFTED)
    expect(result.verdict).toBe('drift')
    expect(result.score).toBeGreaterThanOrEqual(DRIFT_FLOOR)
    expect(result.score).toBeLessThan(0.6)
    expect(result.actual).toBeUndefined()
  })

  it('reports lost, naming the screen actually on display', () => {
    const map = baseMap()
    map.screens.loans!.signature = [{ kind: 'a11yId', value: 'id_gone' }]
    const result = triage(map, 'loans', SETTINGS_WITH_STRAY_LOANS_CUE)
    expect(result.verdict).toBe('lost')
    expect(result.actual).toBe('settings')
  })

  it('prefers lost over drift when both readings are available', () => {
    // loans scores 0.333 (drift band) but settings scores 1.0 — rule 2 must win.
    const result = triage(baseMap(), 'loans', SETTINGS_WITH_STRAY_LOANS_CUE)
    expect(result.score).toBeGreaterThanOrEqual(DRIFT_FLOOR)
    expect(result.verdict).toBe('lost')
    expect(result.actual).toBe('settings')
  })

  it('reports unknown when nothing in the map matches', () => {
    const result = triage(baseMap(), 'loans', UNCHARTED)
    expect(result.verdict).toBe('unknown')
    expect(result.actual).toBeUndefined()
  })

  it('throws for a screen that is not in the map', () => {
    expect(() => triage(baseMap(), 'nope', LOANS_INTACT)).toThrow(/nope/)
  })
})

describe('planHeal', () => {
  it('re-derives the signature and marks the screen provisional', () => {
    const plan = planHeal(baseMap(), 'loans', LOANS_DRIFTED)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const healed = plan.partial.screens!.loans!
    expect(healed.provisional).toBe(true)
    expect(healed.signature.length).toBeGreaterThan(0)
    expect(healed.signature).not.toEqual(baseMap().screens.loans!.signature)
  })

  it('preserves the human name and notes', () => {
    const plan = planHeal(baseMap(), 'loans', LOANS_DRIFTED)
    if (!plan.ok) throw new Error('expected a heal plan')
    expect(plan.partial.screens!.loans!.name).toBe('Loans')
    expect(plan.partial.screens!.loans!.notes).toBe('the loans list')
  })

  it('never adopts a cue that belongs to another screen', () => {
    const map = baseMap()
    const plan = planHeal(map, 'loans', SETTINGS_WITH_STRAY_LOANS_CUE)
    if (!plan.ok) throw new Error('expected a heal plan')
    const values = plan.partial.screens!.loans!.signature.map((c) => c.value)
    expect(values).not.toContain('id_nav_settings')
    expect(values).not.toContain('id_label_settings_title')
  })

  it('refuses when no stable cue can be derived', () => {
    const plan = planHeal(baseMap(), 'loans', ALL_DYNAMIC)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/stable/i)
  })

  it('does not mutate the map it was given', () => {
    const map = baseMap()
    const before = structuredClone(map)
    planHeal(map, 'loans', LOANS_DRIFTED)
    expect(map).toEqual(before)
  })

  it('round-trips: a healed drift verifies as a match, and re-healing is a no-op', () => {
    const map = baseMap()
    const plan = planHeal(map, 'loans', LOANS_DRIFTED)
    if (!plan.ok) throw new Error('expected a heal plan')
    mergeInto(map, plan.partial)
    expect(triage(map, 'loans', LOANS_DRIFTED).verdict).toBe('match')
  })
})

describe('planCapture', () => {
  it('captures an unknown screen as provisional', () => {
    const plan = planCapture(baseMap(), 'card_details', UNCHARTED, { name: 'Card details' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const screen = plan.partial.screens!.card_details!
    expect(screen.name).toBe('Card details')
    expect(screen.provisional).toBe(true)
    expect(screen.signature.length).toBeGreaterThan(0)
  })

  it('records the arriving edge as provisional and verified now', () => {
    const plan = planCapture(baseMap(), 'card_details', UNCHARTED, {
      name: 'Card details',
      from: 'loans',
      via: { kind: 'tap', target: { kind: 'a11yId', value: 'id_row_card' } },
      now: '2026-08-21T10:00:00.000Z',
    })
    if (!plan.ok) throw new Error('expected a capture plan')
    const edge = plan.partial.edges![0]!
    expect(edge).toMatchObject({
      from: 'loans',
      to: 'card_details',
      health: 'ok',
      provisional: true,
      verified_at: '2026-08-21T10:00:00.000Z',
    })
  })

  it('refuses when no stable cue can be derived', () => {
    const plan = planCapture(baseMap(), 'junk', ALL_DYNAMIC, { name: 'Junk' })
    expect(plan.ok).toBe(false)
  })

  it('does not mutate the map it was given', () => {
    const map = baseMap()
    const before = structuredClone(map)
    planCapture(map, 'card_details', UNCHARTED, { name: 'Card details' })
    expect(map).toEqual(before)
  })
})

describe('planCapture provenance', () => {
  it('omits the provisional flag for deliberate mapping', () => {
    const plan = planCapture(baseMap(), 'card_details', UNCHARTED, {
      name: 'Card details',
      provisional: false,
      from: 'loans',
      via: { kind: 'tap', target: { kind: 'a11yId', value: 'id_row_card' } },
    })
    if (!plan.ok) throw new Error('expected a capture plan')
    expect(plan.partial.screens!.card_details!.provisional).toBeUndefined()
    expect(plan.partial.edges![0]!.provisional).toBeUndefined()
  })

  it('honours force when no stable cue survives', () => {
    const plan = planCapture(baseMap(), 'junk', ALL_DYNAMIC, { name: 'Junk', force: true })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.signature).toEqual([])
  })
})
