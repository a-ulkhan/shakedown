import { describe, expect, it } from 'vitest'
import { parseAxeTree } from '../src/drivers/ios.js'

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
