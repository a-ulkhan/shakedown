import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Platform } from './drivers/types.js'
import type { EvidenceStyle } from './evidence/render.js'

/**
 * App profile: how to build, install, and launch the app under test.
 * Lives at .shakedown/config.json in the app repo (committable).
 * A sibling config.local.json (gitignored) can override any field — that is
 * where machine-specific build systems and device choices belong.
 */
export interface PlatformProfile {
  /** bundle id (iOS) / package name (Android) */
  appId: string
  /** built artifact to install: .app dir (iOS) / .apk (Android) */
  artifactPath?: string
  /** shell command that produces the artifact */
  buildCommand?: string
  /** preferred device name / AVD */
  device?: string
}

export type MapStore = 'repo' | 'user'

export interface ShakedownConfig {
  ios?: PlatformProfile
  android?: PlatformProfile
  /** evidence rendering styles, keyed by name (`run render --style <name>`) */
  evidence?: { styles?: Record<string, EvidenceStyle> }
  /**
   * Where map WRITES go by default: "repo" (.shakedown/maps, committable) or
   * "user" (~/.shakedown/maps/<appId>, private). Reads always merge both.
   * Set "user" in config.local.json to keep maps private until the team
   * adopts the tool, then `shakedown map promote` them into the repo.
   */
  mapStore?: MapStore
}

export function configPath(rootDir: string): string {
  return join(rootDir, '.shakedown', 'config.json')
}

export async function loadConfig(rootDir: string): Promise<ShakedownConfig> {
  const basePath = configPath(rootDir)
  const localPath = join(rootDir, '.shakedown', 'config.local.json')
  if (!existsSync(basePath) && !existsSync(localPath)) {
    throw new Error(`no app profile at ${basePath} — create one (see README: App profile)`)
  }
  const base = existsSync(basePath)
    ? (JSON.parse(await readFile(basePath, 'utf-8')) as ShakedownConfig)
    : {}
  const local = existsSync(localPath)
    ? (JSON.parse(await readFile(localPath, 'utf-8')) as ShakedownConfig)
    : {}
  return {
    ...(base.ios || local.ios ? { ios: { ...base.ios, ...local.ios } as PlatformProfile } : {}),
    ...(base.android || local.android
      ? { android: { ...base.android, ...local.android } as PlatformProfile }
      : {}),
    ...(base.evidence || local.evidence
      ? { evidence: { styles: { ...base.evidence?.styles, ...local.evidence?.styles } } }
      : {}),
    ...(local.mapStore || base.mapStore ? { mapStore: local.mapStore ?? base.mapStore } : {}),
  }
}

/** Like loadConfig, but returns {} when no config exists (map commands work without a profile). */
export async function tryLoadConfig(rootDir: string): Promise<ShakedownConfig> {
  try {
    return await loadConfig(rootDir)
  } catch {
    return {}
  }
}

export async function platformProfile(rootDir: string, platform: Platform): Promise<PlatformProfile> {
  const config = await loadConfig(rootDir)
  const profile = config[platform]
  if (!profile?.appId) {
    throw new Error(`app profile has no ${platform} section (or it is missing appId)`)
  }
  return profile
}
