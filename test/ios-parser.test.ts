import { describe, expect, it } from 'vitest'
import { parseAxeTree, parseIosEngine, parseSimUseTree } from '../src/drivers/ios.js'

// axe emits a non-string AXValue for value-bearing controls. This tree mixes a
// numeric slider value, a boolean switch value, an empty label, and a normal
// button so the normalizer is exercised end to end.
const SAMPLE_TREE = JSON.stringify([
  {
    type: 'Window',
    AXLabel: '',
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: 'Button',
        AXLabel: 'From account',
        AXUniqueId: 'id_button_transfers_betweenOwnFromAccount',
        AXValue: null,
        frame: { x: 20, y: 209, width: 166, height: 41 },
      },
      {
        type: 'Slider',
        AXLabel: 'Amount',
        AXValue: 0.5,
        frame: { x: 20, y: 300, width: 362, height: 30 },
      },
      {
        type: 'Switch',
        AXLabel: 'Save template',
        AXValue: true,
        frame: { x: 20, y: 360, width: 51, height: 31 },
      },
    ],
  },
])

describe('parseAxeTree', () => {
  it('does not throw on non-string AXValue (slider/switch) and coerces to string', () => {
    const roots = parseAxeTree(SAMPLE_TREE)
    expect(roots).toHaveLength(1)

    const [button, slider, toggle] = roots[0]?.children ?? []

    // Regression: a numeric AXValue used to crash with "value.trim is not a function".
    expect(slider?.value).toBe('0.5')
    expect(toggle?.value).toBe('true')

    // Strings still normalize as before; empty/null collapse to undefined.
    expect(button?.identifier).toBe('id_button_transfers_betweenOwnFromAccount')
    expect(button?.value).toBeUndefined()
    expect(roots[0]?.label).toBeUndefined()
  })
})

// Trimmed from a real `sim-use describe-ui --json` on the iPhone Duo cover display (sim-use 0.16.0).
const SIM_USE_ENVELOPE = JSON.stringify({
  ok: true,
  data: {
    appLabel: 'PayseraDev',
    outline: 'App: PayseraDev  466x678  (cover display)',
    raw: [
      {
        type: 'Application',
        AXLabel: 'PayseraDev',
        AXUniqueId: null,
        AXValue: null,
        frame: { x: 0, y: 0, width: 466, height: 678 },
        children: [
          {
            type: 'RadioButton',
            AXLabel: 'Cards',
            AXUniqueId: null,
            AXValue: 0,
            frame: { x: 396, y: 444, width: 44, height: 58 },
            children: [],
          },
          {
            type: 'Button',
            AXLabel: 'Settings',
            AXUniqueId: 'HomeSettingsButtonAccessId',
            AXValue: null,
            frame: { x: 16, y: 27, width: 48, height: 48 },
            children: [],
          },
        ],
      },
    ],
  },
})

describe('parseSimUseTree', () => {
  it('reads the AXe-shaped tree from the envelope raw field', () => {
    const roots = parseSimUseTree(SIM_USE_ENVELOPE)
    const [cards, settings] = roots[0]?.children ?? []

    expect(roots[0]?.label).toBe('PayseraDev')
    expect(cards?.value).toBe('0')
    expect(cards?.frame).toEqual({ x: 396, y: 444, width: 44, height: 58 })
    expect(settings?.identifier).toBe('HomeSettingsButtonAccessId')
  })

  it('fails loudly on an error envelope instead of returning an empty screen', () => {
    expect(() => parseSimUseTree(JSON.stringify({ ok: false, error: 'SpringBoard is not running' }))).toThrow(
      /no tree/
    )
  })
})

describe('parseIosEngine', () => {
  it('defaults to sim-use and accepts axe', () => {
    expect(parseIosEngine(undefined)).toBe('sim-use')
    expect(parseIosEngine('axe')).toBe('axe')
    expect(() => parseIosEngine('idb')).toThrow(/expected sim-use or axe/)
  })
})
