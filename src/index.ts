import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { appendLine, asRecord, asString, nowIso } from './util.js'
import { resolveGuardPaths, type GuardPaths } from './paths.js'
import { addAlert, ackAlert, loadState, pushScanHistory, saveState, type GuardState } from './state.js'
import { enablePlugin, repairPlugins, setPluginEnabled, uninstallPlugin } from './remediate.js'
import { SOFT_SETTINGS_NS, loadSchemastery, normalizeSoft, type SoftSettingsValue } from './soft-settings.js'
import {
  buildRegistration,
  consumeIncidents,
  ensureSupervisor,
  readIncidentStats,
  requestRestart,
  supervisorStatus,
} from './supervisor-control.js'
import { runScan, type ScanReport } from './scan.js'
import { registerRoutes, type GuardApi } from './api.js'

export const name = 'dsh-upgrade-guard'

const PACKAGE_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

export interface Config {
  /** 自动重扫间隔（毫秒），0 = 只在启动/宿主版本变化/手动时扫描。 */
  autoScanMs?: number
  /** 是否在每次启动都写一条扫描记录（默认 true）。 */
  recordBootScans?: boolean
  /** 是否启用宿主外 supervisor（崩溃救援/回滚/手动重启，默认 true）。 */
  supervisor?: boolean
  /** supervisor 是否为宿主版本保留快照（默认 true）。 */
  snapshotHost?: boolean
}

interface ContextLike {
  get(name: string): any
  inject(names: string[], callback: (ctx: ContextLike) => void): void
  effect(callback: () => unknown, label?: string): unknown
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void; error?(...args: unknown[]): void }
  loader?: { entries?: () => unknown[] }
}

export function apply(ctx: ContextLike, config: Config = {}): void {
  const guard = new Guard(ctx, config)
  guard.start()
}

class Guard implements GuardApi {
  private readonly ctx: ContextLike
  private readonly config: Required<Config>
  private readonly paths: GuardPaths
  private state: GuardState
  private soft: SoftSettingsValue = { enabled: true, autoScan: true }
  private settingsScope: { get(): unknown; update(patch: object): Promise<void>; watch(cb: (next: unknown) => void): () => void } | null = null
  private started = false
  private scanInFlight: Promise<ScanReport> | null = null
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  private autoTimer: ReturnType<typeof setInterval> | null = null

  constructor(ctx: ContextLike, config: Config) {
    this.ctx = ctx
    this.config = {
      autoScanMs: config.autoScanMs ?? 0,
      recordBootScans: config.recordBootScans ?? true,
      supervisor: config.supervisor ?? true,
      snapshotHost: config.snapshotHost ?? true,
    }
    this.paths = resolveGuardPaths()
    this.state = loadState(this.paths)
  }

  start(): void {
    this.ctx.inject(['webServer'], (hostCtx) => {
      hostCtx.effect(() => registerRoutes(hostCtx, this.paths, this), 'upgrade-guard: routes')
    })
    // 等 boot 尘埃落定：webServer 就绪 + 2s 宽限，再跑首次检查。
    this.scheduleBootCheck(0)
    this.ctx.inject(['settings'], (scoped: any) => {
      void (async () => {
        try {
          const z = await loadSchemastery(this.paths)
          if (z === null || typeof z?.object !== 'function') {
            this.log('soft settings unavailable', { reason: 'schemastery not resolvable from profile' })
            return
          }
          const schema = z.object({
            enabled: z.boolean().default(true),
            autoScan: z.boolean().default(true),
          })
          const scope = scoped.settings.register(SOFT_SETTINGS_NS, schema, { base: { enabled: true, autoScan: true } })
          this.settingsScope = scope
          const apply = (value: unknown): void => {
            this.soft = normalizeSoft(value)
            this.restartAutoTimer()
          }
          apply(scope.get())
          scope.watch(apply)
          this.log('soft settings registered', this.soft)
        } catch (error) {
          this.log('soft settings unavailable', { error: error instanceof Error ? error.message : String(error) })
        }
      })()
    })
    this.restartAutoTimer()
    this.refreshOwnClient()
    this.log('guard started', { profile: this.paths.profile, host: this.paths.hostVersion })
  }

  /** 官方 bundle 装配/宿主重启后，主动刷新自己的 client bundle 摘要并通知浏览器。 */
  private refreshOwnClient(): void {
    this.ctx.inject(['clientModules'], () => {
      const cm = this.ctx.get('clientModules')
      if (cm === undefined) return
      const run = (): void => {
        try {
          if (typeof cm.processOne === 'function') cm.processOne(name)
          if (typeof cm.rebuilt === 'function') cm.rebuilt(name)
          if (typeof cm.compose === 'function') cm.composed = cm.compose()
          if (typeof cm.notifyGraphChanged === 'function') cm.notifyGraphChanged()
          this.log('client bundle refreshed')
        } catch (error) {
          this.log('client bundle refresh failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
      const timer = setTimeout(run, 1500)
      timer.unref?.()
    })
  }

  private restartAutoTimer(): void {
    if (this.autoTimer !== null) {
      clearInterval(this.autoTimer)
      this.autoTimer = null
    }
    if (!this.soft.enabled || !this.soft.autoScan) return
    const interval = this.config.autoScanMs > 0 ? this.config.autoScanMs : 5 * 60 * 1000
    this.autoTimer = setInterval(() => { void this.check('boot') }, interval)
    this.autoTimer.unref?.()
  }

  private scheduleBootCheck(attempt: number): void {
    this.bootTimer = setTimeout(() => {
      try {
        const webServer = this.ctx.get('webServer')
        if (webServer === undefined && attempt < 30) {
          this.scheduleBootCheck(attempt + 1)
          return
        }
        setTimeout(() => { void this.onBoot() }, 2000)
      } catch (error) {
        this.log('schedule boot check failed (guarded)', { error: error instanceof Error ? error.message : String(error) })
      }
    }, 500)
    this.bootTimer.unref?.()
  }

  private async onBoot(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.onBootUnsafe()
    } catch (error) {
      this.log('boot check failed (guarded)', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async onBootUnsafe(): Promise<void> {
    this.log('soft state', this.soft)
    const hostVersion = this.paths.hostVersion
    const previous = this.state.baseline?.hostVersion ?? null
    const upgraded = previous !== null && previous !== hostVersion
    if (this.state.baseline === null) {
      this.state.baseline = {
        hostVersion,
        hostDir: this.paths.hostDir,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        previousHostVersion: null,
      }
    } else {
      this.state.baseline = {
        ...this.state.baseline,
        // 只有真正发生版本变化时才记录"上一次版本"，热重载/重启不覆盖
        previousHostVersion: upgraded ? previous : (this.state.baseline.previousHostVersion ?? null),
        hostVersion,
        hostDir: this.paths.hostDir,
        lastSeenAt: nowIso(),
      }
    }
    const registration = buildRegistration(this.paths, this.webServerPort())
    registration.snapshotHost = this.config.snapshotHost
    const ensured = ensureSupervisor(this.paths, registration, this.config.supervisor)
    const incidents = consumeIncidents(this.paths, this.state)
    this.state.supervisor = { enabled: this.config.supervisor, pid: ensured.pid, adoptedAt: nowIso() }
    this.log('supervisor', { running: ensured.running, pid: ensured.pid, spawned: ensured.spawned, detail: ensured.detail, incidents })
    if (!this.soft.enabled) {
      this.log('soft disabled: skip automatic scan')
      saveState(this.paths, this.state)
      return
    }
    const report = await this.check(upgraded ? 'host-upgrade' : 'boot')
    this.handleReportAlert(report, upgraded)
    saveState(this.paths, this.state)
    this.log('boot check done', { trigger: report.trigger, counts: report.counts })
  }

  private handleReportAlert(report: ScanReport, upgraded: boolean): void {
    const risky = report.counts.risk + report.counts.broken
    const previousRisky = (this.state.lastScan !== null && this.state.lastScan !== report)
      ? this.state.lastScan.counts.risk + this.state.lastScan.counts.broken
      : null
    if (upgraded && risky === 0) {
      addAlert(this.state, {
        kind: 'info',
        severity: 'info',
        title: '宿主升级后兼容检查通过',
        body: `宿主已更新到 ${report.hostVersion ?? '未知版本'}，${report.total} 个已安装插件全部通过声明与加载检查。`,
        actions: [{ id: 'check', label: '再看一眼', api: 'check' }],
      })
      return
    }
    if (risky === 0) return
    if (!upgraded && previousRisky !== null && previousRisky >= risky) return
    const bad = report.plugins.filter((item) => item.status === 'risk' || item.status === 'broken')
    addAlert(this.state, {
      kind: upgraded ? 'host-upgraded' : 'scan-risk',
      severity: 'error',
      title: upgraded ? `宿主升级到 ${report.hostVersion ?? '未知版本'}，发现 ${risky} 个插件不兼容` : `发现 ${risky} 个插件不兼容`,
      body: bad.slice(0, 8).map((item) => {
        const issue = item.issues.find((entry) => entry.level === 'risk')
        return `· ${item.name}${item.version !== null ? `@${item.version}` : ''}：${issue?.message ?? '存在风险'}`
      }).join('\n') + (bad.length > 8 ? `\n…其余 ${bad.length - 8} 个见设置页` : ''),
      actions: [
        { id: 'check', label: '重新扫描', api: 'check' },
        { id: 'repair', label: '一键修复', api: 'repair' },
      ],
    })
  }

  async getState(): Promise<Record<string, unknown>> {
    const unseen = this.state.alerts.filter((item) => !item.seen)
    return {
      profile: this.paths.profile,
      guardVersion: PACKAGE_VERSION,
      hostVersion: this.paths.hostVersion,
      hostDir: this.paths.hostDir,
      baseline: this.state.baseline,
      counts: this.state.lastScan?.counts ?? null,
      lastScan: this.state.lastScan,
      scanHistory: this.state.scanHistory,
      alerts: unseen,
      disabledByGuard: this.state.disabledByGuard,
      supervisor: { ...this.state.supervisor, ...supervisorStatus(this.paths) },
      soft: this.soft,
      incidents: readIncidentStats(this.paths),
      updatedAt: this.state.updatedAt,
    }
  }

  async check(trigger: ScanReport['trigger'] = 'manual'): Promise<ScanReport> {
    if (this.scanInFlight !== null) return await this.scanInFlight
    this.scanInFlight = (async () => {
      const entries = this.loaderEntries()
      const report = runScan(this.paths, trigger, entries as any[])
      if (trigger !== 'boot' || this.config.recordBootScans) pushScanHistory(this.state, report)
      this.state.lastScan = report
      saveState(this.paths, this.state)
      return report
    })()
    try {
      return await this.scanInFlight
    } finally {
      this.scanInFlight = null
    }
  }

  private webServerPort(): number | null {
    try {
      const port = this.ctx.get('webServer')?.port
      return typeof port === 'number' && port > 0 ? port : null
    } catch {
      return null
    }
  }

  private loaderEntries(): unknown[] {
    try {
      const entries = this.ctx.loader?.entries?.()
      if (Array.isArray(entries)) return entries
      if (entries !== null && entries !== undefined && typeof (entries as Iterable<unknown>)[Symbol.iterator] === 'function') {
        return Array.from(entries as Iterable<unknown>)
      }
      return []
    } catch {
      return []
    }
  }

  ack(id: string): boolean {
    const ok = ackAlert(this.state, id)
    if (ok) saveState(this.paths, this.state)
    return ok
  }

  ackAll(): number {
    let count = 0
    for (const alert of this.state.alerts) {
      if (!alert.seen) { alert.seen = true; count += 1 }
    }
    if (count > 0) saveState(this.paths, this.state)
    return count
  }

  async updateSoftConfig(patch: { enabled?: boolean; autoScan?: boolean }): Promise<Record<string, unknown>> {
    const next = {
      enabled: patch.enabled ?? this.soft.enabled,
      autoScan: patch.autoScan ?? this.soft.autoScan,
    }
    if (this.settingsScope !== null) {
      await this.settingsScope.update(next)
    } else {
      this.soft = next
      this.restartAutoTimer()
    }
    return { ok: true, detail: '兼容守卫设置已更新', soft: this.soft }
  }

  async repair(name?: string, dryRun = false): Promise<Record<string, unknown>> {
    const outcome = await repairPlugins(
      this.paths,
      this.state,
      () => runScan(this.paths, 'manual', this.loaderEntries() as any[]),
      { name, dryRun },
    )
    this.state.lastScan = outcome.report
    if (!dryRun && outcome.restartRequired) {
      addAlert(this.state, {
        kind: 'action-done',
        severity: 'warning',
        title: '兼容修复已执行，需要重启生效',
        body: outcome.actions.map((action) => `· ${action.plugin} / ${action.action}：${action.detail}`).join('\n') || outcome.detail,
        actions: [{ id: 'restart', label: '立即重启', api: 'restart' }],
      })
    }
    saveState(this.paths, this.state)
    return {
      ok: outcome.ok,
      detail: outcome.detail,
      actions: outcome.actions,
      restartRequired: outcome.restartRequired,
      dryRun: outcome.dryRun,
      report: outcome.report,
    }
  }

  async toggle(name: string, enabled: boolean): Promise<Record<string, unknown>> {
    const report = this.state.lastScan ?? await this.check('manual')
    const result = await setPluginEnabled(this.paths, this.state, report, name, enabled)
    if (result.ok && !result.restartRequired) {
      const timer = setTimeout(() => { void this.check('manual').catch(() => undefined) }, 1800)
      timer.unref?.()
    }
    saveState(this.paths, this.state)
    return { ...result }
  }

  async uninstall(name: string, allowSelf = false): Promise<Record<string, unknown>> {
    const report = this.state.lastScan ?? await this.check('manual')
    const result = await uninstallPlugin(this.paths, this.state, report, name, { allowSelf })
    if (result.ok && result.restartRequired) {
      addAlert(this.state, {
        kind: 'action-done',
        severity: 'info',
        title: `已卸载 ${name}`,
        body: '文件已从 profile 移除，重启 DSH 后彻底消失。',
        actions: [{ id: 'restart', label: '立即重启', api: 'restart' }],
      })
    }
    saveState(this.paths, this.state)
    return { ...result }
  }

  async enable(name: string): Promise<Record<string, unknown>> {
    const result = enablePlugin(this.paths, this.state, name)
    if (result.restartRequired) {
      addAlert(this.state, {
        kind: 'action-done',
        severity: 'info',
        title: `已恢复 ${name}`,
        body: 'disabled patch 已移除，重启后该插件会重新加载。',
        actions: [{ id: 'restart', label: '立即重启', api: 'restart' }],
      })
    }
    saveState(this.paths, this.state)
    return result
  }

  async restart(): Promise<Record<string, unknown>> {
    if (typeof (process as unknown as { resourcesPath?: string }).resourcesPath === 'string') {
      return { ok: false, detail: '当前是 Desktop/Electron 宿主，生命周期由桌面应用管理，请用桌面应用自带的重启/重载。' }
    }
    const status = supervisorStatus(this.paths)
    if (!status.running) {
      return { ok: false, detail: 'supervisor 未运行，无法自动重启。请手动重启 DSH（或先重启一次让 supervisor 接管）。' }
    }
    const result = requestRestart(this.paths, 'UI 手动重启')
    return {
      ok: result.ok,
      detail: `${result.detail}。页面可能断开，稍后重新打开 DSH URL（或从启动器重开）即可。`,
      supervisor: status,
    }
  }

  openLog(): string {
    return `日志文件：${this.paths.logFile}\n状态文件：${this.paths.stateFile}`
  }

  private log(message: string, extra?: unknown): void {
    const line = `[${nowIso()}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`
    appendLine(this.paths.logFile, line)
    this.ctx.logger?.info?.(`[upgrade-guard] ${message}`, ...(extra === undefined ? [] : [extra]))
    try { console.log(`[upgrade-guard] ${message}`, extra ?? '') } catch { /* ignore */ }
  }
}

export { Guard }
