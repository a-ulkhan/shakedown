import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Evidence run sessions. Each run gets a directory under .shakedown/runs/
 * holding numbered step screenshots, an optional recording, and report.json —
 * the structured artifact a reviewer (or CI) reads.
 */
export type StepOutcome = 'pass' | 'fail' | 'info'
export type RunStatus = 'running' | 'pass' | 'fail' | 'aborted'

export interface RunStep {
  index: number
  title: string
  outcome: StepOutcome
  at: string
  screenshot?: string
  detail?: unknown
}

export interface RunReport {
  name: string
  platform?: string
  device?: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  steps: RunStep[]
  recording?: string
  summary?: string
  /** Map edits made while self-healing during this run */
  mapEdits: string[]
}

function reportPath(runDir: string): string {
  return join(runDir, 'report.json')
}

export async function startRun(
  rootDir: string,
  name: string,
  meta: { platform?: string; device?: string } = {}
): Promise<{ dir: string; report: RunReport }> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(rootDir, '.shakedown', 'runs', `${stamp}_${slug}`)
  await mkdir(dir, { recursive: true })
  const report: RunReport = {
    name,
    ...(meta.platform !== undefined && { platform: meta.platform }),
    ...(meta.device !== undefined && { device: meta.device }),
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: [],
    mapEdits: [],
  }
  await writeFile(reportPath(dir), JSON.stringify(report, null, 2), 'utf-8')
  return { dir, report }
}

export async function loadRun(runDir: string): Promise<RunReport> {
  return JSON.parse(await readFile(reportPath(runDir), 'utf-8')) as RunReport
}

async function saveRun(runDir: string, report: RunReport): Promise<void> {
  await writeFile(reportPath(runDir), JSON.stringify(report, null, 2), 'utf-8')
}

export async function appendStep(
  runDir: string,
  step: { title: string; outcome: StepOutcome; screenshot?: string; detail?: unknown }
): Promise<RunStep> {
  const report = await loadRun(runDir)
  const entry: RunStep = {
    index: report.steps.length + 1,
    title: step.title,
    outcome: step.outcome,
    at: new Date().toISOString(),
    ...(step.screenshot !== undefined && { screenshot: step.screenshot }),
    ...(step.detail !== undefined && { detail: step.detail }),
  }
  report.steps.push(entry)
  await saveRun(runDir, report)
  return entry
}

export async function recordMapEdit(runDir: string, description: string): Promise<void> {
  const report = await loadRun(runDir)
  report.mapEdits.push(description)
  await saveRun(runDir, report)
}

export async function finishRun(
  runDir: string,
  status: Exclude<RunStatus, 'running'>,
  extras: { summary?: string; recording?: string } = {}
): Promise<RunReport> {
  const report = await loadRun(runDir)
  report.status = status
  report.finishedAt = new Date().toISOString()
  if (extras.summary !== undefined) report.summary = extras.summary
  if (extras.recording !== undefined) report.recording = extras.recording
  await saveRun(runDir, report)
  return report
}
