import { execFile, spawn } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
}

export class ExecError extends Error {
  constructor(
    public readonly command: string,
    public readonly code: number | null,
    public readonly stderr: string
  ) {
    super(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`)
    this.name = 'ExecError'
  }
}

export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as NodeJS.ErrnoException).code === 'number'
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : null
          reject(new ExecError([cmd, ...args].join(' '), code, stderr))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

/**
 * Spawn a long-lived process detached from this CLI invocation
 * (e.g. a screen recorder that a later invocation will stop).
 * Returns the child pid.
 */
export function spawnDetached(cmd: string, args: string[]): number {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  if (child.pid === undefined) {
    throw new Error(`failed to spawn ${cmd}`)
  }
  child.unref()
  return child.pid
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
