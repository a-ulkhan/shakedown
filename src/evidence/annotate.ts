import { rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { run } from '../util/exec.js'
import type { Rect } from '../drivers/types.js'

/**
 * Evidence rendering: draw id/label highlights + captions onto screenshots and
 * stitch them into a walkthrough video. This layer only orchestrates — the
 * pixels are done by ImageMagick (`magick`) and ffmpeg, which are OPTIONAL: if
 * a tool is missing the caller is expected to degrade to raw capture, not fail.
 */

export class ToolMissingError extends Error {
  constructor(public readonly tool: string) {
    super(`${tool} is not installed — required for this evidence step (e.g. brew install ${tool})`)
    this.name = 'ToolMissingError'
  }
}

const toolCache = new Map<string, boolean>()

export async function hasTool(tool: string): Promise<boolean> {
  const cached = toolCache.get(tool)
  if (cached !== undefined) return cached
  let ok = false
  try {
    await run('which', [tool])
    ok = true
  } catch {
    ok = false
  }
  toolCache.set(tool, ok)
  return ok
}

export interface ImageSize {
  width: number
  height: number
}

export async function imageSize(path: string): Promise<ImageSize> {
  if (!(await hasTool('magick'))) throw new ToolMissingError('imagemagick')
  const { stdout } = await run('magick', ['identify', '-format', '%w %h', path])
  const [w, h] = stdout.trim().split(/\s+/).map(Number)
  return { width: w ?? 0, height: h ?? 0 }
}

/**
 * Accessibility frames are in logical points; screenshots are in pixels. The
 * scale is derived, not hardcoded, by comparing the screenshot width to the
 * root node's width — so it is correct on any device (@2x, @3x, SE, Pro).
 */
export function pixelScale(rootFrameWidth: number, imageWidthPx: number): number {
  if (rootFrameWidth <= 0 || imageWidthPx <= 0) return 1
  return imageWidthPx / rootFrameWidth
}

export function scaleRect(rect: Rect, scale: number): Rect {
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  }
}

export interface Highlight {
  /** box in PIXELS (already scaled from AX points via scaleRect) */
  box: Rect
  color?: string
}

export interface AnnotateOptions {
  src: string
  out: string
  title?: string
  subtitle?: string
  highlights?: Highlight[]
}

const CAPTION_BG = 'rgba(15,23,42,0.9)'
const TITLE_COLOR = 'white'
const SUBTITLE_COLOR = '#7CF6C8'
const HIGHLIGHT_COLOR = '#FF3B30'

/**
 * Pure builder for the `magick` argument vector. Kept separate from execution
 * so the geometry/caption math is unit-testable without ImageMagick installed.
 * Band height, font sizes, padding, and stroke width all scale with the image,
 * so it renders consistently across device resolutions.
 */
export function buildAnnotateArgs(size: ImageSize, opts: AnnotateOptions): string[] {
  const hasCaption = Boolean(opts.title || opts.subtitle)
  const bandH = hasCaption ? Math.round(size.height * 0.088) : 0
  const pad = Math.round(size.width * 0.028)
  const titlePt = Math.max(12, Math.round(size.height * 0.0175))
  const subPt = Math.max(10, Math.round(size.height * 0.0115))
  const stroke = Math.max(4, Math.round(size.width * 0.008))

  const args: string[] = [opts.src]

  if (bandH > 0) {
    args.push('-fill', CAPTION_BG, '-draw', `rectangle 0,0,${size.width},${bandH}`)
    if (opts.title) {
      args.push(
        '-stroke', 'none', '-fill', TITLE_COLOR, '-font', 'Helvetica-Bold',
        '-pointsize', String(titlePt), '-annotate', `+${pad}+${Math.round(bandH * 0.36)}`, opts.title
      )
    }
    if (opts.subtitle) {
      args.push(
        '-stroke', 'none', '-fill', SUBTITLE_COLOR, '-font', 'Courier-Bold',
        '-pointsize', String(subPt), '-annotate', `+${pad}+${Math.round(bandH * 0.66)}`, opts.subtitle
      )
    }
  }

  for (const highlight of opts.highlights ?? []) {
    const x2 = Math.round(highlight.box.x + highlight.box.width)
    const y2 = Math.round(highlight.box.y + highlight.box.height)
    args.push(
      '-stroke', highlight.color ?? HIGHLIGHT_COLOR, '-strokewidth', String(stroke), '-fill', 'none',
      '-draw', `rectangle ${Math.round(highlight.box.x)},${Math.round(highlight.box.y)},${x2},${y2}`
    )
  }

  args.push(opts.out)
  return args
}

export async function annotateShot(opts: AnnotateOptions, size?: ImageSize): Promise<string> {
  if (!(await hasTool('magick'))) throw new ToolMissingError('imagemagick')
  const dims = size ?? (await imageSize(opts.src))
  await run('magick', buildAnnotateArgs(dims, opts))
  return opts.out
}

export interface StitchFrame {
  path: string
  seconds: number
}

/**
 * Pure builder for the ffmpeg concat-demuxer list. The last frame is repeated
 * with a tiny duration because the concat demuxer ignores the final entry's
 * declared duration otherwise.
 */
export function buildConcatList(frames: StitchFrame[]): string {
  const lines: string[] = []
  for (const frame of frames) {
    lines.push(`file '${resolve(frame.path).replace(/'/g, "'\\''")}'`)
    lines.push(`duration ${frame.seconds}`)
  }
  const last = frames[frames.length - 1]
  if (last) {
    lines.push(`file '${resolve(last.path).replace(/'/g, "'\\''")}'`)
    lines.push('duration 0.1')
  }
  return `${lines.join('\n')}\n`
}

export async function stitchFrames(opts: { frames: StitchFrame[]; out: string; gif?: boolean }): Promise<string> {
  if (!(await hasTool('ffmpeg'))) throw new ToolMissingError('ffmpeg')
  if (opts.frames.length === 0) throw new Error('no frames to stitch')

  const listPath = `${opts.out}.concat.txt`
  await writeFile(listPath, buildConcatList(opts.frames), 'utf-8')

  const evenScale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
  const args = opts.gif
    ? ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
       '-vf', `fps=12,${evenScale}:flags=lanczos`, opts.out]
    : ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
       '-vf', `${evenScale},fps=30`, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', opts.out]

  try {
    await run('ffmpeg', args, { timeoutMs: 120_000 })
  } finally {
    await rm(listPath, { force: true })
  }
  return opts.out
}
