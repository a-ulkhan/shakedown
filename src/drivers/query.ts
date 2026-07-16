import type { ElementSelector, Point, UiNode } from './types.js'

/** Depth-first collection of every node matching the selector. */
export function findAll(roots: UiNode[], selector: ElementSelector): UiNode[] {
  const matches: UiNode[] = []
  const visit = (node: UiNode) => {
    if (matches.length < 100 && matchesSelector(node, selector)) {
      matches.push(node)
    }
    node.children.forEach(visit)
  }
  roots.forEach(visit)
  return matches
}

export function findFirst(roots: UiNode[], selector: ElementSelector): UiNode | undefined {
  return findAll(roots, selector)[0]
}

export function matchesSelector(node: UiNode, selector: ElementSelector): boolean {
  if (selector.identifier !== undefined && node.identifier !== selector.identifier) return false
  if (selector.label !== undefined && node.label !== selector.label) return false
  if (selector.value !== undefined && node.value !== selector.value) return false
  if (selector.type !== undefined && node.type !== selector.type) return false
  return (
    selector.identifier !== undefined ||
    selector.label !== undefined ||
    selector.value !== undefined ||
    selector.type !== undefined
  )
}

export function center(node: UiNode): Point {
  return {
    x: Math.round(node.frame.x + node.frame.width / 2),
    y: Math.round(node.frame.y + node.frame.height / 2),
  }
}

export function describeSelector(selector: ElementSelector): string {
  const parts: string[] = []
  if (selector.identifier) parts.push(`id=${selector.identifier}`)
  if (selector.label) parts.push(`label=${selector.label}`)
  if (selector.value) parts.push(`value=${selector.value}`)
  if (selector.type) parts.push(`type=${selector.type}`)
  return parts.join(' ') || '<empty selector>'
}
