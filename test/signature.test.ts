import { describe, expect, it } from 'vitest'
import {
  deriveSignature,
  identifyScreen,
  isDynamicCueValue,
  scoreScreen,
  verifyScreen,
} from '../src/map/signature.js'
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

describe('isDynamicCueValue', () => {
  it('rejects amounts, hashes, indexed ids, timers, and overlong strings', () => {
    expect(isDynamicCueValue('€100,00')).toBe(true)
    expect(isDynamicCueValue('0,02₾')).toBe(true)
    expect(isDynamicCueValue('3616cf9bfec1fcebc49c2ffa54b7caa7')).toBe(true) // hash
    expect(isDynamicCueValue('id_statement_cell_0_0')).toBe(true) // indexed id
    expect(isDynamicCueValue('Resend code in 01:57')).toBe(true) // timer
    expect(isDynamicCueValue('x'.repeat(50))).toBe(true)
  })

  it('accepts fixed, human labels and clean identifiers', () => {
    expect(isDynamicCueValue('New transfer')).toBe(false)
    expect(isDynamicCueValue('Payment account')).toBe(false)
    expect(isDynamicCueValue('id_button_continue')).toBe(false)
    expect(isDynamicCueValue('HomeSettingsButtonAccessId')).toBe(false)
  })
})

describe('deriveSignature', () => {
  const flat = (roots: UiNode[]) => flattenForTest(roots)

  it('prefers a11y ids and skips generic nav chrome', () => {
    const screen = flat([
      node({ identifier: 'id_navigation_button_back', label: 'Back' }),
      node({ label: 'Cancel' }),
      node({ identifier: 'HomeSettingsButtonAccessId', label: 'Settings', frame: { x: 0, y: 10, width: 40, height: 40 } }),
      node({ identifier: 'QrHomeViewButtonId', label: 'QR Code', frame: { x: 0, y: 20, width: 40, height: 40 } }),
    ])
    const sig = deriveSignature(screen, { max: 3 })
    const values = sig.map((c) => c.value)
    expect(values).toContain('HomeSettingsButtonAccessId')
    expect(values).toContain('QrHomeViewButtonId')
    expect(values).not.toContain('id_navigation_button_back') // chrome
    expect(values).not.toContain('Cancel') // chrome
  })

  it('falls back to a stable header when a screen is all dynamic data', () => {
    const screen = flat([
      node({ label: 'Transaction details', frame: { x: 0, y: 5, width: 200, height: 30 } }), // stable title
      node({ label: 'Name a00f3024d9448c4c31838640d7c35268', frame: { x: 0, y: 40, width: 200, height: 20 } }),
      node({ value: '-0,01₾', frame: { x: 0, y: 60, width: 60, height: 20 } }),
      node({ identifier: 'id_statement_cell_0_0', frame: { x: 0, y: 80, width: 200, height: 40 } }),
    ])
    const sig = deriveSignature(screen)
    expect(sig).toEqual([{ kind: 'label', value: 'Transaction details' }])
  })

  it('excludes cues already used by other screens and caps at max', () => {
    const screen = flat([
      node({ identifier: 'id_shared_tabbar', frame: { x: 0, y: 0, width: 40, height: 40 } }),
      node({ identifier: 'id_unique_a', frame: { x: 0, y: 10, width: 40, height: 40 } }),
      node({ identifier: 'id_unique_b', frame: { x: 0, y: 20, width: 40, height: 40 } }),
      node({ identifier: 'id_unique_c', frame: { x: 0, y: 30, width: 40, height: 40 } }),
    ])
    const sig = deriveSignature(screen, { max: 2, exclude: new Set(['a11yId:id_shared_tabbar']) })
    expect(sig).toHaveLength(2)
    expect(sig.map((c) => c.value)).not.toContain('id_shared_tabbar')
  })

  it('returns [] when nothing stable survives', () => {
    const screen = flat([node({ label: '€100,00' }), node({ value: '01:57' })])
    expect(deriveSignature(screen)).toEqual([])
  })

  it('round-trips: a derived signature verifies the same screen (score >= threshold)', () => {
    const roots: UiNode[] = [
      node({
        type: 'Application',
        children: [
          node({ identifier: 'id_navigation_button_back', label: 'Back' }),
          node({ label: 'Reset password', frame: { x: 0, y: 5, width: 200, height: 30 } }),
          node({ label: 'Reset with email', frame: { x: 0, y: 700, width: 120, height: 20 } }),
          node({ identifier: 'id_text_input_phone', frame: { x: 0, y: 100, width: 200, height: 40 } }),
        ],
      }),
    ]
    const signature = deriveSignature(flattenForTest(roots))
    expect(signature.length).toBeGreaterThan(0)
    const map: NavigationMap = {
      app: 'x', platform: 'ios', schema: 1, anchors: [],
      screens: { reset: { name: 'Reset', signature } }, edges: [],
    }
    expect(verifyScreen(map, 'reset', roots).ok).toBe(true)
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
