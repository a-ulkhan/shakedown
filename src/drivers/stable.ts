import type { Driver, UiNode } from './types.js'
import { sleep as realSleep } from '../util/exec.js'

/**
 * A cheap structural fingerprint of the UI tree, used to detect when a screen
 * has stopped changing after a navigation. Deliberately EXCLUDES node `value`
 * so a blinking caret or a ticking clock label does not read as "still moving";
 * frames are integer-rounded for the same reason (sub-pixel animation settles).
 * A node whose only change is its value (e.g. a field being filled) is treated
 * as stable — callers waiting on a value should poll `ui find` instead.
 */
export function treeSignature(roots: UiNode[]): string {
  const parts: string[] = []
  const visit = (n: UiNode) => {
    const f = n.frame
    parts.push(
      `${n.type}|${n.identifier ?? ''}|${n.label ?? ''}|` +
        `${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)}`
    )
    n.children.forEach(visit)
  }
  roots.forEach(visit)
  return parts.join('\n')
}

export interface StableOptions {
  /** Tree must stay unchanged this long to count as settled. */
  settleMs?: number
  /** Hard cap; returns the last snapshot even if never settled. */
  timeoutMs?: number
  /** Delay between describe polls. */
  pollMs?: number
}

/** Injectable clock/sleep so the poll loop is deterministic under test. */
export interface StableDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Describe the UI, polling until the tree stops changing for `settleMs` (or
 * `timeoutMs` elapses). Never throws on timeout — an animated screen (spinner)
 * simply rides to the deadline and returns its last snapshot. A transient
 * describe error mid-poll is swallowed and retried, keeping the last good tree.
 */
export async function describeStable(
  driver: Pick<Driver, 'describeUi'>,
  deviceId: string,
  options: StableOptions = {},
  deps: StableDeps = {}
): Promise<UiNode[]> {
  const settleMs = options.settleMs ?? 400
  const pollMs = options.pollMs ?? 200
  const timeoutMs = Math.max(options.timeoutMs ?? 5000, settleMs)
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now

  const start = now()
  let last = await driver.describeUi(deviceId) // always at least one describe
  let lastSig = treeSignature(last)
  let lastChange = now()

  while (now() - start < timeoutMs) {
    if (now() - lastChange >= settleMs) return last
    await sleep(pollMs)
    let current: UiNode[]
    try {
      current = await driver.describeUi(deviceId)
    } catch {
      continue // transient axe hiccup: keep last good tree, retry
    }
    const sig = treeSignature(current)
    last = current
    if (sig !== lastSig) {
      lastSig = sig
      lastChange = now()
    }
  }
  return last
}
