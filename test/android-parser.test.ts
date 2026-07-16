import { describe, expect, it } from 'vitest'
import { parseBounds, parseUiautomatorDump } from '../src/drivers/android-parser.js'

const SAMPLE_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Loans" resource-id="com.example.demo:id/title" class="android.widget.TextView" package="com.example.demo" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,120][500,180]" />
    <node index="1" text="" resource-id="com.example.demo:id/submit" class="android.widget.Button" package="com.example.demo" content-desc="Submit &amp; continue" checkable="false" checked="false" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,2000][980,2100]" />
  </node>
</hierarchy>`

describe('parseUiautomatorDump', () => {
  it('builds the tree with normalized fields', () => {
    const roots = parseUiautomatorDump(SAMPLE_DUMP)
    expect(roots).toHaveLength(1)
    const frame = roots[0]
    expect(frame?.type).toBe('FrameLayout')
    expect(frame?.children).toHaveLength(2)

    const title = frame?.children[0]
    expect(title?.type).toBe('TextView')
    expect(title?.label).toBe('Loans') // falls back to text when content-desc empty
    expect(title?.identifier).toBe('com.example.demo:id/title')
    expect(title?.value).toBe('Loans')
    expect(title?.frame).toEqual({ x: 48, y: 120, width: 452, height: 60 })

    const button = frame?.children[1]
    expect(button?.label).toBe('Submit & continue') // content-desc wins, entities decoded
    expect(button?.enabled).toBe(false)
  })

  it('handles a dump with trailing dump-path noise', () => {
    const withNoise = `${SAMPLE_DUMP}\nUI hierchary dumped to: /dev/tty`
    const roots = parseUiautomatorDump(withNoise)
    expect(roots).toHaveLength(1)
  })
})

describe('parseBounds', () => {
  it('parses the [l,t][r,b] format', () => {
    expect(parseBounds('[10,20][110,220]')).toEqual({ x: 10, y: 20, width: 100, height: 200 })
  })

  it('returns a zero rect for malformed input', () => {
    expect(parseBounds('garbage')).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
