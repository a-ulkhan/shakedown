import { findFirst, describeSelector } from '../drivers/query.js'
import type { Driver, ElementSelector } from '../drivers/types.js'
import {
  annotateShot,
  hasTool,
  imageSize,
  pixelScale,
  scaleRect,
  type Highlight,
} from './annotate.js'

export interface CaptureResult {
  path: string
  annotated: boolean
  /** Present when a selector was given but no element matched. */
  warning?: string
}

/**
 * Capture a screenshot and, when a selector is given, highlight the resolved
 * element with a caption. Degrades gracefully: if ImageMagick is missing, or
 * the element is not found, it still returns the raw screenshot with a warning
 * instead of throwing — evidence capture must never block a run.
 */
export async function captureAnnotatedShot(
  driver: Driver,
  deviceId: string,
  outPath: string,
  opts: { selector?: ElementSelector; title?: string } = {}
): Promise<CaptureResult> {
  await driver.screenshot(deviceId, outPath)

  const hasSelector = opts.selector !== undefined && Object.keys(opts.selector).length > 0
  if (!hasSelector && !opts.title) {
    return { path: outPath, annotated: false }
  }

  if (!(await hasTool('magick'))) {
    return { path: outPath, annotated: false, warning: 'imagemagick not installed; saved raw screenshot' }
  }

  const size = await imageSize(outPath)
  const highlights: Highlight[] = []
  let subtitle: string | undefined
  let warning: string | undefined

  if (hasSelector && opts.selector) {
    const roots = await driver.describeUi(deviceId)
    const element = findFirst(roots, opts.selector)
    if (!element) {
      warning = `no element matched ${describeSelector(opts.selector)}; saved screenshot without highlight`
    } else {
      const scale = pixelScale(roots[0]?.frame.width ?? 0, size.width)
      highlights.push({ box: scaleRect(element.frame, scale) })
      subtitle = element.identifier ?? describeSelector(opts.selector)
    }
  }

  const title =
    opts.title ?? opts.selector?.identifier ?? opts.selector?.label ?? 'shot'

  await annotateShot({ src: outPath, out: outPath, title, subtitle, highlights }, size)
  return {
    path: outPath,
    annotated: highlights.length > 0 || Boolean(opts.title),
    ...(warning !== undefined && { warning }),
  }
}
