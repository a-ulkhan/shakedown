import { describe, expect, it } from 'vitest'
import {
  buildAnnotateArgs,
  buildConcatList,
  pixelScale,
  scaleRect,
} from '../src/evidence/annotate.js'

describe('pixelScale', () => {
  it('derives the scale from screenshot px vs root points (@3x)', () => {
    expect(pixelScale(402, 1206)).toBe(3)
  })

  it('handles @2x', () => {
    expect(pixelScale(375, 750)).toBe(2)
  })

  it('falls back to 1 on degenerate input instead of dividing by zero', () => {
    expect(pixelScale(0, 1206)).toBe(1)
    expect(pixelScale(402, 0)).toBe(1)
  })
})

describe('scaleRect', () => {
  it('scales a logical frame to pixels and rounds', () => {
    expect(scaleRect({ x: 20, y: 209, width: 166, height: 41 }, 3)).toEqual({
      x: 60,
      y: 627,
      width: 498,
      height: 123,
    })
  })
})

describe('buildAnnotateArgs', () => {
  const size = { width: 1206, height: 2622 }

  it('draws a caption band with title + subtitle when captions are present', () => {
    const args = buildAnnotateArgs(size, {
      src: 'in.png',
      out: 'out.png',
      title: 'Step 1',
      subtitle: 'id_button_x',
    })
    expect(args[0]).toBe('in.png')
    expect(args[args.length - 1]).toBe('out.png')
    // caption band rectangle spans the full width
    expect(args).toContain('rectangle 0,0,1206,231')
    expect(args).toContain('Step 1')
    expect(args).toContain('id_button_x')
  })

  it('omits the band entirely when there is no caption', () => {
    const args = buildAnnotateArgs(size, {
      src: 'in.png',
      out: 'out.png',
      highlights: [{ box: { x: 60, y: 627, width: 498, height: 123 } }],
    })
    expect(args.some((a) => a.startsWith('rectangle 0,0,'))).toBe(false)
    // highlight box is drawn as x1,y1,x2,y2
    expect(args).toContain('rectangle 60,627,558,750')
  })

  it('supports multiple highlights', () => {
    const args = buildAnnotateArgs(size, {
      src: 'in.png',
      out: 'out.png',
      highlights: [
        { box: { x: 60, y: 627, width: 498, height: 123 } },
        { box: { x: 678, y: 627, width: 498, height: 123 } },
      ],
    })
    expect(args).toContain('rectangle 60,627,558,750')
    expect(args).toContain('rectangle 678,627,1176,750')
  })
})

describe('buildConcatList', () => {
  it('lists each frame with its duration and repeats the last frame', () => {
    const list = buildConcatList([
      { path: '/runs/step-01.png', seconds: 3 },
      { path: '/runs/step-02.png', seconds: 4 },
    ])
    const lines = list.trim().split('\n')
    expect(lines).toEqual([
      "file '/runs/step-01.png'",
      'duration 3',
      "file '/runs/step-02.png'",
      'duration 4',
      "file '/runs/step-02.png'",
      'duration 0.1',
    ])
  })

  it('produces an empty string for no frames', () => {
    expect(buildConcatList([])).toBe('\n')
  })
})
