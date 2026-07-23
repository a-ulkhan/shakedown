import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderRun } from '../src/evidence/render.js'
import { uploadEvidence } from '../src/evidence/upload.js'
import type { Uploader } from '../src/evidence/upload.js'
import type { RunReport } from '../src/run/session.js'

async function makeRun(report: Partial<RunReport>, shots: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shakedown-render-'))
  await mkdir(dir, { recursive: true })
  const full: RunReport = {
    name: 'demo walkthrough',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'pass',
    steps: [],
    mapEdits: [],
    ...report,
  }
  await writeFile(join(dir, 'report.json'), JSON.stringify(full), 'utf-8')
  for (const shot of shots) {
    // 1x1 png
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000d49444154789c626001000000ffff03000006000557' +
        'bfabd40000000049454e44ae426082',
      'hex'
    )
    await writeFile(join(dir, shot), png)
  }
  return dir
}

describe('renderRun', () => {
  it('renders a summary table from step titles and outcomes', async () => {
    const dir = await makeRun({
      steps: [
        { index: 1, title: 'Main list renders', outcome: 'pass', at: '', screenshot: 'step-01.png' },
        { index: 2, title: 'Search filters', outcome: 'fail', at: '', screenshot: 'step-02.png' },
      ],
    }, ['step-01.png', 'step-02.png'])
    const result = await renderRun(dir, { keyframes: 'all', video: undefined })
    expect(result.markdown).toContain('| Step | Result |')
    expect(result.markdown).toContain('| Main list renders | pass |')
    expect(result.markdown).toContain('| Search filters | FAIL |')
    expect(result.markdown).toContain('### Failures')
    expect(result.markdown).toContain('- Search filters')
  })

  it('selects only marked key frames by default and warns when none are marked', async () => {
    const dir = await makeRun({
      steps: [
        { index: 1, title: 'plain', outcome: 'info', at: '', screenshot: 'step-01.png' },
        { index: 2, title: 'starred', outcome: 'info', at: '', screenshot: 'step-02.png', key: true },
      ],
    }, ['step-01.png', 'step-02.png'])
    const marked = await renderRun(dir, { video: undefined })
    expect(marked.markdown).toContain('step-02')
    expect(marked.markdown).not.toContain('step-01.png')

    const bare = await makeRun({
      steps: [{ index: 1, title: 'plain', outcome: 'info', at: '', screenshot: 'step-01.png' }],
    }, ['step-01.png'])
    const warned = await renderRun(bare, { video: undefined })
    expect(warned.warnings.some((w) => w.includes('--key'))).toBe(true)
  })

  it('lays the key-frame grid out in configured columns with captions', async () => {
    const dir = await makeRun({
      steps: [
        { index: 1, title: 'one', outcome: 'info', at: '', screenshot: 'step-01.png', key: true },
        { index: 2, title: 'two', outcome: 'info', at: '', screenshot: 'step-02.png', key: true },
        { index: 3, title: 'three', outcome: 'info', at: '', screenshot: 'step-03.png', key: true },
      ],
    }, ['step-01.png', 'step-02.png', 'step-03.png'])
    const result = await renderRun(dir, { video: undefined, grid: { columns: 2 } })
    expect(result.markdown).toContain('| one | two |')
    expect(result.markdown).toContain('| three |')
  })

  it('applies a custom template with section placeholders', async () => {
    const dir = await makeRun({
      steps: [{ index: 1, title: 'step', outcome: 'pass', at: '', screenshot: 'step-01.png', key: true }],
    }, ['step-01.png'])
    const result = await renderRun(dir, { video: undefined }, {
      template: '# {{name}} ({{status}})\n\n{{summary-table}}\n\nEND',
    })
    expect(result.markdown).toContain('# demo walkthrough (pass)')
    expect(result.markdown).toContain('| step | pass |')
    expect(result.markdown.trim().endsWith('END')).toBe(true)
  })

  it('skips the video section with a warning when the run has no recording', async () => {
    const dir = await makeRun({
      steps: [{ index: 1, title: 'step', outcome: 'pass', at: '', screenshot: 'step-01.png', key: true }],
    }, ['step-01.png'])
    const result = await renderRun(dir, { video: { maxWidth: 480 } })
    expect(result.video).toBeUndefined()
    expect(result.warnings.some((w) => w.includes('no recording'))).toBe(true)
  })
})

describe('uploadEvidence', () => {
  it('substitutes every asset placeholder with the uploader markdown', async () => {
    const dir = await makeRun({
      steps: [
        { index: 1, title: 'one', outcome: 'pass', at: '', screenshot: 'step-01.png', key: true },
        { index: 2, title: 'two', outcome: 'pass', at: '', screenshot: 'step-02.png', key: true },
      ],
    }, ['step-01.png', 'step-02.png'])
    const rendered = await renderRun(dir, { video: undefined })
    expect(rendered.assets.length).toBe(2)
    const fake: Uploader = {
      name: 'fake',
      upload: (asset) => Promise.resolve({ asset, markdown: `![${asset.altText}](/uploads/x/${asset.altText}.png)` }),
    }
    const uploaded = await uploadEvidence(rendered, fake)
    expect(uploaded.markdown).toContain('(/uploads/x/step-01.png)')
    expect(uploaded.markdown).toContain('(/uploads/x/step-02.png)')
    expect(uploaded.markdown).not.toContain(`(${join(dir, 'step-01.png')})`)
    expect(uploaded.assets.length).toBe(0)
  })
})
