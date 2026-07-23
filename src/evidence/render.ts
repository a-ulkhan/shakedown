import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { run } from '../util/exec.js'
import { hasTool } from './annotate.js'
import { loadRun } from '../run/session.js'
import type { RunReport, RunStep } from '../run/session.js'

/**
 * Evidence rendering: turn a finished run (report.json + step shots +
 * recording) into a publishable markdown document — the same artifact a
 * reviewer sees in an MR description. Layout is driven by an EvidenceStyle
 * (from .shakedown/config.json `evidence.styles`, or the built-in default),
 * assembled from built-in sections; a custom template can override the
 * arrangement via {{section-name}} placeholders.
 */

export interface VideoStyle {
  /** longest-edge target in px; recording is scaled down to this (default 480) */
  maxWidth?: number
  /** output frame rate (default 12) */
  fps?: number
  /** x264 crf quality, higher = smaller (default 33) */
  crf?: number
}

export type KeyframeMode = 'marked' | 'all' | 'failures-only'

export interface EvidenceStyle {
  /** compress and embed the run recording; omit to skip video entirely */
  video?: VideoStyle
  /** which step screenshots make the key-frame grid (default "marked") */
  keyframes?: KeyframeMode
  /** key-frame grid shape (default 3 columns, captions on) */
  grid?: { columns?: number; captions?: boolean }
  /** built-in sections to emit, in order */
  sections?: SectionName[]
}

export type SectionName = 'summary-table' | 'video' | 'keyframe-grid' | 'failures'

export const DEFAULT_STYLE: Required<Pick<EvidenceStyle, 'keyframes' | 'sections'>> & EvidenceStyle = {
  video: { maxWidth: 480, fps: 12, crf: 33 },
  keyframes: 'marked',
  grid: { columns: 3, captions: true },
  sections: ['summary-table', 'video', 'keyframe-grid', 'failures'],
}

/** A local file the markdown references; uploaders swap placeholder → hosted link. */
export interface EvidenceAsset {
  /** absolute path on disk */
  path: string
  /** exact token embedded in the markdown, e.g. ![step-05](step-05.png) */
  placeholder: string
  /** how the placeholder should be rebuilt around an uploaded URL */
  altText: string
}

export interface RenderResult {
  markdown: string
  assets: EvidenceAsset[]
  /** path of the compressed video, when one was produced */
  video?: string
  warnings: string[]
}

const outcomeMark: Record<string, string> = { pass: 'pass', fail: 'FAIL', info: 'done' }

function stepShot(runDir: string, step: RunStep): string | undefined {
  if (!step.screenshot) return undefined
  const candidate = resolve(runDir, step.screenshot)
  if (existsSync(candidate)) return candidate
  return existsSync(step.screenshot) ? step.screenshot : undefined
}

function selectKeyframes(runDir: string, report: RunReport, mode: KeyframeMode): RunStep[] {
  const withShots = report.steps.filter((step) => stepShot(runDir, step))
  switch (mode) {
    case 'all':
      return withShots
    case 'failures-only':
      return withShots.filter((step) => step.outcome === 'fail')
    case 'marked':
      return withShots.filter((step) => step.key)
  }
}

function imageRef(asset: { file: string; alt: string }): string {
  return `![${asset.alt}](${asset.file})`
}

function summaryTable(report: RunReport): string {
  if (report.steps.length === 0) return ''
  const rows = report.steps
    .map((step) => `| ${step.title.replace(/\|/g, '\\|')} | ${outcomeMark[step.outcome] ?? step.outcome} |`)
    .join('\n')
  return `| Step | Result |\n| --- | --- |\n${rows}`
}

function failuresSection(report: RunReport): string {
  const failures = report.steps.filter((step) => step.outcome === 'fail')
  if (failures.length === 0) return ''
  const rows = failures.map((step) => `- ${step.title}`).join('\n')
  return `### Failures\n\n${rows}`
}

function keyframeGrid(
  frames: { file: string; alt: string; caption: string }[],
  grid: { columns?: number; captions?: boolean }
): string {
  if (frames.length === 0) return ''
  const columns = Math.max(1, grid.columns ?? 3)
  const captions = grid.captions ?? true
  const chunks: (typeof frames)[] = []
  for (let i = 0; i < frames.length; i += columns) chunks.push(frames.slice(i, i + columns))
  return chunks
    .map((chunk) => {
      const header = `| ${chunk.map((f) => (captions ? f.caption.replace(/\|/g, '\\|') : ' ')).join(' | ')} |`
      const divider = `| ${chunk.map(() => '---').join(' | ')} |`
      const images = `| ${chunk.map((f) => imageRef(f)).join(' | ')} |`
      return `${header}\n${divider}\n${images}`
    })
    .join('\n\n')
}

/** Compress the run recording with ffmpeg. Returns undefined (with a warning) when impossible. */
async function compressVideo(
  runDir: string,
  report: RunReport,
  style: VideoStyle,
  warnings: string[]
): Promise<string | undefined> {
  // `run finish --recording` is easy to forget; fall back to the conventional
  // recording.mp4 that `ui record start` writes into the run dir.
  const named = report.recording ? resolve(runDir, report.recording) : undefined
  const fallback = join(runDir, 'recording.mp4')
  const source = named && existsSync(named) ? named : existsSync(fallback) ? fallback : undefined
  if (!source) {
    warnings.push('no recording in this run — video section skipped')
    return undefined
  }
  if (!(await hasTool('ffmpeg'))) {
    warnings.push('ffmpeg not installed — video section skipped')
    return undefined
  }
  const width = style.maxWidth ?? 480
  const out = join(runDir, `evidence_${width}p.mp4`)
  await run(
    'ffmpeg',
    ['-y', '-i', source,
     '-vf', `scale=${width}:-2,fps=${style.fps ?? 12}`,
     '-c:v', 'libx264', '-crf', String(style.crf ?? 33), '-preset', 'fast', '-an',
     '-movflags', '+faststart', out],
    { timeoutMs: 600_000 }
  )
  return out
}

export interface RenderOptions {
  /** custom layout: text with {{summary-table}} / {{video}} / {{keyframe-grid}} / {{failures}} / {{name}} / {{status}} placeholders */
  template?: string
}

export async function renderRun(
  runDir: string,
  styleInput: EvidenceStyle = {},
  options: RenderOptions = {}
): Promise<RenderResult> {
  const report = await loadRun(runDir)
  const style: EvidenceStyle = { ...DEFAULT_STYLE, ...styleInput }
  const warnings: string[] = []
  const assets: EvidenceAsset[] = []

  const frames = selectKeyframes(runDir, report, style.keyframes ?? 'marked').map((step) => {
    const file = stepShot(runDir, step) as string
    return { file, alt: basename(file, '.png'), caption: step.title }
  })
  if ((style.keyframes ?? 'marked') === 'marked' && frames.length === 0) {
    warnings.push('no steps marked --key — key-frame grid is empty (use `run shot --key` or keyframes: "all")')
  }
  for (const frame of frames) {
    assets.push({ path: frame.file, placeholder: imageRef(frame), altText: frame.alt })
  }

  const sections = new Map<SectionName, string>()
  sections.set('summary-table', summaryTable(report))
  sections.set('failures', failuresSection(report))
  sections.set('keyframe-grid', keyframeGrid(frames, style.grid ?? {}))

  let video: string | undefined
  if (style.video && (style.sections ?? DEFAULT_STYLE.sections).includes('video')) {
    video = await compressVideo(runDir, report, style.video, warnings)
    if (video) {
      const ref = imageRef({ file: video, alt: basename(video, '.mp4') })
      sections.set('video', ref)
      assets.push({ path: video, placeholder: ref, altText: basename(video, '.mp4') })
    } else {
      sections.set('video', '')
    }
  } else {
    sections.set('video', '')
  }

  let markdown: string
  if (options.template) {
    markdown = options.template
      .replace(/\{\{name\}\}/g, report.name)
      .replace(/\{\{status\}\}/g, report.status)
      .replace(/\{\{summary-table\}\}/g, sections.get('summary-table') ?? '')
      .replace(/\{\{video\}\}/g, sections.get('video') ?? '')
      .replace(/\{\{keyframe-grid\}\}/g, sections.get('keyframe-grid') ?? '')
      .replace(/\{\{failures\}\}/g, sections.get('failures') ?? '')
  } else {
    const parts: string[] = [`## ${report.name}`]
    if (report.summary) parts.push(report.summary)
    for (const name of style.sections ?? DEFAULT_STYLE.sections) {
      const body = sections.get(name)
      if (body) parts.push(body)
    }
    markdown = parts.join('\n\n')
  }

  return { markdown: `${markdown.trim()}\n`, assets, ...(video !== undefined && { video }), warnings }
}

export async function writeEvidence(runDir: string, result: RenderResult, out?: string): Promise<string> {
  const path = out ?? join(runDir, 'evidence.md')
  await writeFile(path, result.markdown, 'utf-8')
  return path
}

export async function loadTemplate(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}
