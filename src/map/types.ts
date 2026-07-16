import type { Platform } from '../drivers/types.js'

export const MAP_SCHEMA_VERSION = 1

/** A stable cue used to recognize a screen ("am I here?"). */
export interface SignatureCue {
  kind: 'a11yId' | 'label' | 'text' | 'type'
  value: string
}

export interface ScreenNode {
  /** Human-readable name, e.g. "Loans" */
  name: string
  /** 2-4 stable cues that together identify this screen */
  signature: SignatureCue[]
  notes?: string
}

export interface EdgeAction {
  kind: 'tap' | 'swipe' | 'type' | 'launch'
  /** tap/type target */
  target?: SignatureCue
  /** type: the text; swipe: up|down|left|right */
  argument?: string
}

export type EdgeHealth = 'ok' | 'stale' | 'broken'

export interface Edge {
  from: string
  to: string
  action: EdgeAction
  verified_at?: string
  app_version?: string
  health: EdgeHealth
}

export interface NavigationMap {
  app: string
  platform: Platform | 'shared'
  schema: number
  /** Screens reachable directly by launching the app */
  anchors: string[]
  screens: Record<string, ScreenNode>
  edges: Edge[]
}

export interface RouteStep {
  from: string
  to: string
  action: EdgeAction
  health: EdgeHealth
}

export interface Route {
  target: string
  start: string
  steps: RouteStep[]
  warnings: string[]
}
