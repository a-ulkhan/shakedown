import type { UiNode } from './types.js'

/**
 * Parse `uiautomator dump` XML into normalized UiNodes.
 *
 * The dump format is a flat, well-formed XML document of <node> elements
 * with double-quoted attributes — a small stack parser is enough and keeps
 * the CLI dependency-free.
 */
export function parseUiautomatorDump(xml: string): UiNode[] {
  const roots: UiNode[] = []
  const stack: UiNode[] = []
  const tokenPattern = /<node\b([^>]*?)(\/?)>|<\/node\s*>/g

  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(xml)) !== null) {
    if (match[0].startsWith('</')) {
      stack.pop()
      continue
    }
    const node = nodeFromAttributes(parseAttributes(match[1] ?? ''))
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
    const selfClosing = match[2] === '/'
    if (!selfClosing) {
      stack.push(node)
    }
  }
  return roots
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const attrPattern = /([\w-]+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = attrPattern.exec(raw)) !== null) {
    attributes.set(match[1] ?? '', decodeXmlEntities(match[2] ?? ''))
  }
  return attributes
}

function nodeFromAttributes(attrs: Map<string, string>): UiNode {
  const className = attrs.get('class') ?? ''
  const text = emptyToUndefined(attrs.get('text'))
  const contentDesc = emptyToUndefined(attrs.get('content-desc'))
  return {
    type: className.split('.').pop() || 'Unknown',
    label: contentDesc ?? text,
    identifier: emptyToUndefined(attrs.get('resource-id')),
    value: text,
    frame: parseBounds(attrs.get('bounds') ?? ''),
    enabled: attrs.get('enabled') !== 'false',
    children: [],
  }
}

/** bounds attribute format: "[left,top][right,bottom]" */
export function parseBounds(bounds: string): UiNode['frame'] {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bounds)
  if (!match) return { x: 0, y: 0, width: 0, height: 0 }
  const left = Number(match[1])
  const top = Number(match[2])
  const right = Number(match[3])
  const bottom = Number(match[4])
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
