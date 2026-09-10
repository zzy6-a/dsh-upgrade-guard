import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

export function readJsonValue(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免断电留下半个文件。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path))
  try {
    const prev = existsSync(path) ? readFileSync(path, 'utf8') : ''
    writeFileSync(path, prev + line + '\n', 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function stamp(): string {
  return nowIso().replace(/[:.]/g, '-').slice(0, 19)
}

export function short(text: unknown, max = 200): string {
  const s = typeof text === 'string' ? text : String(text)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function resolveFrom(base: string, ...parts: string[]): string {
  return resolve(base, ...parts)
}

export function exists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

export function joinPath(...parts: string[]): string {
  return join(...parts)
}

/** 逃逸为单行、可放进状态文件里的错误文本。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return short(error.stack ?? error.message, 1200)
  return short(error, 1200)
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  error?: string
}

/** 运行一个子进程并收集输出（不弹 shell，除非显式需要）。 */
export async function runCommand(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean } = {},
): Promise<CommandResult> {
  const { spawn } = await import('node:child_process')
  return await new Promise<CommandResult>((resolveResult) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolveResult({ code: -1, stdout, stderr, error: `timeout after ${options.timeoutMs ?? 0}ms` })
    }, options.timeoutMs ?? 120_000)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({ code: -1, stdout, stderr, error: errorText(error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({ code: code ?? -1, stdout, stderr })
    })
  })
}
