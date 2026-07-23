import { describe, expect, it } from 'vitest'
import { describeStable, treeSignature } from '../src/drivers/stable.js'
import type { UiNode } from '../src/drivers/types.js'

function node(partial: Partial<UiNode>): UiNode {
  return {
    type: 'Button',
    frame: { x: 0, y: 0, width: 10, height: 10 },
    enabled: true,
    children: [],
    ...partial,
  }
}

describe('treeSignature', () => {
  it('is equal for structurally identical trees', () => {
    const a = [node({ identifier: 'id_a', label: 'A' })]
    const b = [node({ identifier: 'id_a', label: 'A' })]
    expect(treeSignature(a)).toBe(treeSignature(b))
  })

  it('ignores value-only changes (caret / clock churn)', () => {
    const a = [node({ identifier: 'field', value: '12:00' })]
    const b = [node({ identifier: 'field', value: '12:01' })]
    expect(treeSignature(a)).toBe(treeSignature(b))
  })

  it('differs when a frame moves', () => {
    const a = [node({ label: 'X', frame: { x: 0, y: 0, width: 10, height: 10 } })]
    const b = [node({ label: 'X', frame: { x: 0, y: 40, width: 10, height: 10 } })]
    expect(treeSignature(a)).not.toBe(treeSignature(b))
  })

  it('differs when a label or identifier changes', () => {
    expect(treeSignature([node({ label: 'X' })])).not.toBe(treeSignature([node({ label: 'Y' })]))
    expect(treeSignature([node({ identifier: 'a' })])).not.toBe(treeSignature([node({ identifier: 'b' })]))
  })
})

/** A fake clock that advances a fixed step every sleep(), so the poll loop is instant + deterministic. */
function fakeClock(stepMs: number) {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms > 0 ? ms : stepMs
    },
  }
}

describe('describeStable', () => {
  it('returns once the tree settles', async () => {
    const trees = [
      [node({ label: 'loading' })],
      [node({ label: 'loading' })],
      [node({ label: 'done' })], // changes here...
      [node({ label: 'done' })], // ...then holds
      [node({ label: 'done' })],
      [node({ label: 'done' })],
    ]
    let i = 0
    const driver = { describeUi: async () => trees[Math.min(i++, trees.length - 1)] }
    const clock = fakeClock(200)
    const result = await describeStable(driver, 'dev', { settleMs: 400, timeoutMs: 5000, pollMs: 200 }, clock)
    expect(result[0].label).toBe('done')
  })

  it('returns the last snapshot at timeout when never stable (animation)', async () => {
    let i = 0
    const driver = { describeUi: async () => [node({ label: `frame-${i++}` })] } // always changing
    const clock = fakeClock(200)
    const result = await describeStable(driver, 'dev', { settleMs: 400, timeoutMs: 1000, pollMs: 200 }, clock)
    expect(result[0].label).toMatch(/^frame-/)
  })

  it('swallows a transient describe error mid-poll', async () => {
    const trees = [[node({ label: 'a' })], null, [node({ label: 'a' })], [node({ label: 'a' })], [node({ label: 'a' })]]
    let i = 0
    const driver = {
      describeUi: async () => {
        const t = trees[Math.min(i++, trees.length - 1)]
        if (t === null) throw new Error('axe hiccup')
        return t
      },
    }
    const clock = fakeClock(200)
    const result = await describeStable(driver, 'dev', { settleMs: 400, timeoutMs: 5000, pollMs: 200 }, clock)
    expect(result[0].label).toBe('a')
  })
})
