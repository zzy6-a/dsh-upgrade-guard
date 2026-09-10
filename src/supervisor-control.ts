import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addAlert, type GuardState } from './state.js'
import type { GuardPaths } from './paths.js'
import { ensureDir, nowIso, readJson, readJsonValue, writeJsonAtomic } from './util.js'

export interface HostRegistration {
  pid: number
  startedAt: string
  bin: string
  node: string
  args: string[]
  cwd: string
  profile: string
  profileDir: string
  dshHome: string
  patchFile: string
  hostDir: string | null
  hostVersion: string | null
  port: number | null
  logFile: string
  snapshotHost?: boolean
}

export interface SupervisorStatus {
  pid: number | null
  running: boolean
  mode: string | null
  targetPid: number | null
  hostVersion: string | null
  currentRuntime: string | null
  startedAt: string | null
  updatedAt: string | null
}

function isAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readPidFile(file: string): number | null {
  try {
    const text = readFileSync(file, 'utf8').trim()
    const pid = Number(text)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function supervisorStatus(paths: GuardPaths): SupervisorStatus {
  const pid = readPidFile(paths.supervisorPidFile)
  const status = readJson(paths.supervisorStatusFile)
  return {
    pid,
    running: isAlive(pid),
    mode: typeof status?.mode === 'string' ? status.mode : null,
    targetPid: typeof status?.targetPid === 'number' ? status.targetPid : null,
    hostVersion: typeof status?.hostVersion === 'string' ? status.hostVersion : null,
    currentRuntime: typeof status?.currentRuntime === 'string' ? status.currentRuntime : null,
    startedAt: typeof status?.startedAt === 'string' ? status.startedAt : null,
    updatedAt: typeof status?.updatedAt === 'string' ? status.updatedAt : null,
  }
}

export function buildRegistration(paths: GuardPaths, port: number | null): HostRegistration {
  const logCandidates = [join(paths.dshHome, 'logs', 'web.log')]
  const logFile = logCandidates.find((file) => existsSync(file)) ?? join(paths.guardDir, 'host.log')
  return {
    pid: process.pid,
    startedAt: nowIso(),
    bin: process.argv[1] ?? '',
    node: process.execPath,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    profile: paths.profile,
    profileDir: paths.profileDir,
    dshHome: paths.dshHome,
    patchFile: paths.profilePatchFile,
    hostDir: paths.hostDir,
    hostVersion: paths.hostVersion,
    port,
    logFile,
  }
}

/** 写入 host.json（supervisor 轮询它来 adopt 当前宿主）。 */
export function writeRegistration(paths: GuardPaths, registration: HostRegistration): void {
  writeJsonAtomic(join(paths.guardDir, 'host.json'), registration)
}

function copySupervisorAsset(paths: GuardPaths): string {
  ensureDir(paths.guardDir)
  const source = fileURLToPath(new URL('./supervisor.mjs', import.meta.url))
  const target = paths.supervisorFile
  try {
    const next = readFileSync(source)
    const prev = existsSync(target) ? readFileSync(target) : null
    if (prev === null || !prev.equals(next)) writeFileSync(target, next)
  } catch {
    /* 运行中的旧 supervisor 仍可用；下次启动再更新 */
  }
  return target
}

export interface EnsureResult {
  running: boolean
  pid: number | null
  spawned: boolean
  detail: string
}

/**
 * 确保 supervisor 常驻：已有存活进程则 adopt；否则 detached 启动守护进程。
 * supervisor 代码复制到 guardDir，插件升级/卸载都不影响它。
 */
export function ensureSupervisor(paths: GuardPaths, registration: HostRegistration, enabled: boolean): EnsureResult {
  writeRegistration(paths, registration)
  if (!enabled) return { running: false, pid: null, spawned: false, detail: 'supervisor 已按配置关闭' }
  if (typeof (process as unknown as { resourcesPath?: string }).resourcesPath === 'string') {
    return { running: false, pid: null, spawned: false, detail: 'Desktop/Electron 宿主的生命周期由外壳管理，跳过 supervisor' }
  }
  const existing = supervisorStatus(paths)
  if (existing.running) return { running: true, pid: existing.pid, spawned: false, detail: 'supervisor 已在运行（adopt 当前宿主）' }

  const supervisorPath = copySupervisorAsset(paths)
  try {
    const child = spawn(process.execPath, [supervisorPath, '--guard-dir', paths.guardDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_GUARD_DIR: paths.guardDir },
    })
    child.unref()
    return { running: true, pid: child.pid ?? null, spawned: true, detail: 'supervisor 已启动' }
  } catch (error) {
    return { running: false, pid: null, spawned: false, detail: `supervisor 启动失败：${String(error)}` }
  }
}

export function requestRestart(paths: GuardPaths, reason: string): { ok: boolean; detail: string } {
  ensureDir(paths.controlDir)
  const payload = { action: 'restart', reason, at: nowIso(), pid: process.pid }
  const file = join(paths.controlDir, 'restart.json')
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows 下目标已存在时 rename 可能失败：先删再改名
    try { rmSync(file, { force: true }) } catch { /* ignore */ }
    renameSync(tmp, file)
  }
  return { ok: true, detail: '已把重启请求交给 supervisor' }
}

export interface Incident {
  id: string
  at: string
  kind: string
  severity: 'info' | 'warning' | 'error'
  title: string
  body: string
  actions: Array<{ id: string; label: string; api: string; payload?: Record<string, unknown>; danger?: boolean }>
  consumed?: boolean
  disabled?: { name: string; entryIds: string[]; appended: string | null; backup: string | null; reason: string }
  runtime?: { version: string | null; bin: string | null }
}

function listIncidentFiles(paths: GuardPaths): string[] {
  if (!existsSync(paths.incidentsDir)) return []
  try {
    return readdirSync(paths.incidentsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(paths.incidentsDir, name))
  } catch {
    return []
  }
}

/** 读取 supervisor 写下的未消费事故报告，转成 UI 提醒/禁用记录。 */
export function consumeIncidents(paths: GuardPaths, state: GuardState): number {
  let count = 0
  for (const file of listIncidentFiles(paths)) {
    const raw = readJsonValue(file)
    if (raw === null || typeof raw !== 'object') continue
    const incident = raw as Incident
    if (incident.consumed === true) continue
    addAlert(state, {
      id: incident.id,
      kind: incident.kind === 'auto-rollback' ? 'boot-rescued' : 'boot-rescued',
      severity: incident.severity ?? 'warning',
      title: incident.title ?? 'supervisor 自愈报告',
      body: incident.body ?? '',
      actions: incident.actions ?? [{ id: 'restart', label: '重启 DSH', api: 'restart' }],
    })
    if (incident.disabled !== undefined) {
      state.disabledByGuard = state.disabledByGuard.filter((item) => item.name !== incident.disabled?.name)
      state.disabledByGuard.push({
        name: incident.disabled.name,
        entryIds: incident.disabled.entryIds,
        at: incident.at,
        reason: incident.disabled.reason,
        backup: incident.disabled.backup,
        appended: incident.disabled.appended,
      })
    }
    incident.consumed = true
    try { writeFileSync(file, JSON.stringify(incident, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
    count += 1
  }
  return count
}

export function readIncidentStats(paths: GuardPaths): { total: number; unconsumed: number } {
  const files = listIncidentFiles(paths)
  let unconsumed = 0
  for (const file of files) {
    const raw = readJsonValue(file)
    if (raw !== null && typeof raw === 'object' && (raw as Incident).consumed !== true) unconsumed += 1
  }
  return { total: files.length, unconsumed }
}

export function supervisorPaths(paths: GuardPaths): Record<string, string> {
  return {
    guardDir: paths.guardDir,
    supervisor: paths.supervisorFile,
    hostJson: join(paths.guardDir, 'host.json'),
    status: paths.supervisorStatusFile,
    control: paths.controlDir,
    incidents: paths.incidentsDir,
    snapshots: paths.snapshotsDir,
  }
}

export { isAlive }
