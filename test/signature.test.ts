import { describe, expect, it } from 'vitest'
import { identifyScreen, scoreScreen, verifyScreen } from '../src/map/signature.js'
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

const LOANS_SCREEN: UiNode[] = [
  node({
    type: 'Application',
    children: [
      node({ type: 'NavigationBar', label: 'Loans', identifier: 'id_nav_loans' }),
      node({ type: 'StaticText', label: 'Active loans', identifier: 'id_label_loans_title' }),
      node({ type: 'Button', label: 'New loan', identifier: 'id_button_new_loan' }),
    ],
  }),
]

function makeMap(): NavigationMap {
  return {
    app: 'com.example.demo',
    platform: 'ios',
    schema: 1,
    anchors: ['home'],
    screens: {
      home: {
        name: 'Home',
        signature: [
          { kind: 'a11yId', value: 'id_home_balance' },
          { kind: 'label', value: 'Welcome back' },
        ],
      },
      loans: {
        name: 'Loans',
        signature: [
          { kind: 'a11yId', value: 'id_label_loans_title' },
          { kind: 'label', value: 'Loans' },
        ],
      },
    },
    edges: [],
  }
}

describe('scoreScreen', () => {
  it('scores 1.0 when every cue matches (nested nodes included)', () => {
    const { score, missed } = scoreScreen(
      [
        { kind: 'a11yId', value: 'id_button_new_loan' },
        { kind: 'label', value: 'Active loans' },
        { kind: 'type', value: 'NavigationBar' },
      ],
      flattenForTest(LOANS_SCREEN)
    )
    expect(score).toBe(1)
    expect(missed).toHaveLength(0)
  })

  it('weights a11yId misses more heavily than type misses', () => {
    const nodes = flattenForTest(LOANS_SCREEN)
    const missingId = scoreScreen(
      [
        { kind: 'a11yId', value: 'id_does_not_exist' },
        { kind: 'label', value: 'Active loans' },
      ],
      nodes
    )
    const missingType = scoreScreen(
      [
        { kind: 'type', value: 'DoesNotExist' },
        { kind: 'label', value: 'Active loans' },
      ],
      nodes
    )
    expect(missingId.score).toBeLessThan(missingType.score)
  })

  it('scores 0 for an empty signature', () => {
    expect(scoreScreen([], flattenForTest(LOANS_SCREEN)).score).toBe(0)
  })
})

describe('identifyScreen', () => {
  it('ranks the actual screen first', () => {
    const matches = identifyScreen(makeMap(), LOANS_SCREEN)
    expect(matches[0]?.screen).toBe('loans')
    expect(matches[0]?.score).toBe(1)
    expect(matches[1]?.score).toBe(0)
  })
})

describe('verifyScreen', () => {
  it('accepts the matching screen', () => {
    const result = verifyScreen(makeMap(), 'loans', LOANS_SCREEN)
    expect(result.ok).toBe(true)
  })

  it('rejects a non-matching screen and reports missed cues', () => {
    const result = verifyScreen(makeMap(), 'home', LOANS_SCREEN)
    expect(result.ok).toBe(false)
    expect(result.missed).toHaveLength(2)
  })

  it('throws for unknown screen ids', () => {
    expect(() => verifyScreen(makeMap(), 'ghost', LOANS_SCREEN)).toThrow(/unknown screen/)
  })
})

// verifyScreen/identifyScreen flatten internally; tests for scoreScreen need it done here
function flattenForTest(roots: UiNode[]): UiNode[] {
  const nodes: UiNode[] = []
  const visit = (candidate: UiNode) => {
    nodes.push(candidate)
    candidate.children.forEach(visit)
  }
  roots.forEach(visit)
  return nodes
}
