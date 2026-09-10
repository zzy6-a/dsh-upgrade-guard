import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostCoreInventory, type GuardPaths } from './paths.js'
import { resolvePackageDir } from './inventory.js'
import {
  appendEntryOverrides,
  backupFiles,
  disableEntryIds,
  dumpComposeMap,
  enableEntryIds,
  hostBinPath,
} from './patch.js'
import { chooseCompatibleTarget, fetchRegistryManifests } from './registry.js'
import { readJson, runCommand, short } from './util.js'
import type { PluginReport, ScanReport } from './scan.js'
import type { DisabledRecord, GuardState } from './state.js'

export interface ActionLog {
  plugin: string
  action: string
  ok: boolean
  detail: string
}

export interface RepairOutcome {
  ok: boolean
  dryRun: boolean
  detail: string
  actions: ActionLog[]
  restartRequired: boolean
  report: ScanReport
}

interface RepairOptions {
  name?: string
  dryRun?: boolean
}

function installedVersion(paths: GuardPaths, name: string): string | null {
  const resolved = resolvePackageDir(paths, name)
  if (resolved.dir === null) return null
  try {
    const manifest = JSON.parse(readFileSync(join(resolved.dir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

function pluginBuildScript(paths: GuardPaths, name: string): string | null {
  const resolved = resolvePackageDir(paths, name)
  if (resolved.dir === null) return null
  try {
    const manifest = JSON.parse(readFileSync(join(resolved.dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    return typeof manifest.scripts?.build === 'string' ? manifest.scripts.build : null
  } catch {
    return null
  }
}

async function runDshPlugin(paths: GuardPaths, args: string[], timeoutMs = 600_000): Promise<{ code: number; output: string }> {
  const bin = hostBinPath()
  if (bin === '') return { code: -1, output: '无法确定 dsh bin 路径' }
  const result = await runCommand(process.execPath, [bin, 'plugin', '--profile', paths.profile, ...args], {
    cwd: paths.profileDir,
    timeoutMs,
  })
  return { code: result.code, output: short(`${result.stdout}\n${result.stderr}`.trim(), 2000) }
}

function risky(plugin: PluginReport): boolean {
  return plugin.status === 'risk' || plugin.status === 'broken'
}

/**
 * 修复链（需用户确认后调用）：
 * npm 插件 → 找"与当前宿主兼容的最高版本"安装；
 * 找不到/安装后仍风险 → 尝试 pnpm install / 本地构建；
 * 仍风险 → 写入 disabled patch 兜底。
 * dryRun = 只给计划，不改任何文件。
 */
export async function repairPlugins(
  paths: GuardPaths,
  state: GuardState,
  scanNow: () => ScanReport,
  options: RepairOptions = {},
): Promise<RepairOutcome> {
  const dryRun = options.dryRun === true
  const actions: ActionLog[] = []
  let restartRequired = false
  let report = scanNow()
  let targets = report.plugins.filter(risky)
  if (options.name !== undefined && options.name !== '') {
    targets = targets.filter((plugin) => plugin.name === options.name)
  }
  if (targets.length === 0) {
    return {
      ok: true,
      dryRun,
      detail: options.name === undefined || options.name === ''
        ? '没有需要修复的不兼容/损坏插件'
        : `${options.name} 当前没有可修复的问题`,
      actions,
      restartRequired: false,
      report,
    }
  }

  for (const target of targets) {
    if (target.trust === 'system') {
      actions.push({ plugin: target.name, action: 'skip', ok: true, detail: '官方随宿主升级的 bundle，由宿主版本管理，跳过自动修复' })
      continue
    }
    const installed = target.version ?? installedVersion(paths, target.name)

    if (target.sourceKind === 'npm' && target.spec !== null && installed !== null) {
      const listing = await fetchRegistryManifests(target.name)
      if (listing === null) {
        actions.push({ plugin: target.name, action: 'check-update', ok: false, detail: 'registry 查询失败（网络/镜像问题），转入本地修复' })
      } else {
        const choice = chooseCompatibleTarget(installed, listing.versions, paths.hostVersion, hostCoreInventory(paths.hostDir), listing.latest)
        if (choice.compatible !== null && choice.compatible !== installed) {
          const action = {
            plugin: target.name,
            action: 'update',
            ok: true,
            detail: `计划安装 ${choice.compatible}（latest=${choice.latest ?? '?'}，依据=${choice.reason}）`,
          }
          if (dryRun) {
            actions.push(action)
            continue
          }
          backupFiles(paths, [paths.profilePackageJson, paths.profilePatchFile, join(paths.profileDir, 'pnpm-lock.yaml')], `update-${target.name.replace(/[\\/@]/g, '_')}`)
          const result = await runDshPlugin(paths, ['add', `${target.name}@${choice.compatible}`])
          const after = installedVersion(paths, target.name)
          if (result.code === 0 && after === choice.compatible) {
            actions.push({ ...action, detail: `已安装 ${choice.compatible}` })
            restartRequired = true
            continue
          }
          actions.push({
            plugin: target.name,
            action: 'update',
            ok: false,
            detail: `安装未达目标（exit=${result.code}，实际=${after ?? '?'}）：${result.output}`,
          })
        } else {
          actions.push({
            plugin: target.name,
            action: 'check-update',
            ok: true,
            detail: `没有更高且兼容的版本（latest=${choice.latest ?? '?'}，reason=${choice.reason}），转入本地修复`,
          })
        }
      }
    }

    // 本地修复：重装依赖 / 重建 junction / 本地源码构建
    const repairAction = { plugin: target.name, action: 'repair-install', ok: true, detail: '计划 pnpm install + 本地构建（如声明）' }
    if (dryRun) {
      actions.push(repairAction)
      continue
    }
    backupFiles(paths, [paths.profilePackageJson, paths.profilePatchFile, join(paths.profileDir, 'pnpm-lock.yaml')], `repair-${target.name.replace(/[\\/@]/g, '_')}`)
    const install = await runDshPlugin(paths, ['install'])
    actions.push({ ...repairAction, ok: install.code === 0, detail: `pnpm install exit=${install.code}${install.code === 0 ? '' : `：${install.output}`}` })
    const buildScript = pluginBuildScript(paths, target.name)
    const resolved = resolvePackageDir(paths, target.name)
    if (buildScript !== null && resolved.dir !== null) {
      const build = await runCommand('npm', ['run', 'build'], { cwd: resolved.dir, timeoutMs: 300_000, shell: process.platform === 'win32' })
      actions.push({
        plugin: target.name,
        action: 'rebuild',
        ok: build.code === 0,
        detail: build.code === 0 ? '本地 build 完成' : `本地 build exit=${build.code}：${short(`${build.stdout}\n${build.stderr}`, 600)}`,
      })
    }
    restartRequired = true
  }

  report = scanNow()
  const statusByName = new Map(report.plugins.map((plugin) => [plugin.name, plugin.status]))
  for (const target of targets) {
    if (target.trust === 'system') continue
    const status = statusByName.get(target.name)
    if (status !== 'risk' && status !== 'broken') continue
    // 兜底：禁用
    if (dryRun) {
      actions.push({ plugin: target.name, action: 'disable', ok: true, detail: '计划写入 disabled patch（当前仍不兼容）' })
      continue
    }
    const compose = await dumpComposeMap(paths)
    const entryIds = compose.byName.get(target.name) ?? target.entryIds
    const result = disableEntryIds(paths, target.name, entryIds, `修复后仍不兼容（status=${status}）`)
    if (result.ok) {
      const record: DisabledRecord = {
        name: target.name,
        entryIds: result.entryIds,
        at: new Date().toISOString(),
        reason: `修复后仍不兼容（status=${status}）`,
        backup: result.backup,
        appended: result.appended,
      }
      state.disabledByGuard = state.disabledByGuard.filter((item) => item.name !== target.name)
      state.disabledByGuard.push(record)
      restartRequired = true
    }
    actions.push({ plugin: target.name, action: 'disable', ok: result.ok, detail: result.detail })
  }

  const failed = actions.filter((action) => !action.ok)
  return {
    ok: failed.length === 0,
    dryRun,
    detail: failed.length === 0
      ? `修复流程完成：${actions.length} 个动作${restartRequired ? '，需要重启使改动生效' : ''}`
      : `完成但有 ${failed.length} 个动作失败：${failed.map((action) => `${action.plugin}/${action.action}`).join('、')}`,
    actions,
    restartRequired,
    report,
  }
}

/** 恢复守卫禁用的插件（删除之前追加的 disabled 文本）。 */
export function enablePlugin(paths: GuardPaths, state: GuardState, name: string): { ok: boolean; detail: string; restartRequired: boolean } {
  const record = state.disabledByGuard.find((item) => item.name === name)
  if (record === undefined) return { ok: false, detail: `没有 ${name} 的守卫禁用记录`, restartRequired: false }
  const result = enableEntryIds(paths, record.appended ?? null, name)
  if (!result.ok) return { ok: false, detail: result.detail, restartRequired: false }
  state.disabledByGuard = state.disabledByGuard.filter((item) => item.name !== name)
  return { ok: true, detail: result.detail, restartRequired: true }
}

export function disabledPatchExists(paths: GuardPaths, state: GuardState, name: string): boolean {
  const record = state.disabledByGuard.find((item) => item.name === name)
  if (record === undefined) return false
  if (record.appended === null || record.appended === undefined) return existsSync(paths.profilePatchFile)
  try {
    return readFileSync(paths.profilePatchFile, 'utf8').includes(record.appended)
  } catch {
    return false
  }
}

export interface ToggleOutcome {
  ok: boolean
  detail: string
  entryIds: string[]
  restartRequired: boolean
}

function profilePatchIsLive(paths: GuardPaths): boolean {
  const manifest = readJson(paths.profilePackageJson)
  const dsh = manifest?.dsh as Record<string, unknown> | undefined
  const profile = dsh?.profile as Record<string, unknown> | undefined
  return (profile?.patchReload ?? 'live') === 'live'
}

/** 开关插件：向 cordis.patch.yml 写入 disabled 覆盖行，web profile 下由 DSH 自身 HMR 即时重组。 */
const SELF_PACKAGE = 'dsh-upgrade-guard'

export async function setPluginEnabled(
  paths: GuardPaths,
  state: GuardState,
  report: ScanReport,
  name: string,
  enabled: boolean,
): Promise<ToggleOutcome> {
  if (name === SELF_PACKAGE) return { ok: false, detail: '兼容守卫不能在这里禁用自己', entryIds: [], restartRequired: false }
  const plugin = report.plugins.find((item) => item.name === name)
  if (plugin === undefined) return { ok: false, detail: `未找到插件 ${name}`, entryIds: [], restartRequired: false }
  let entryIds = plugin.entryIds
  if (entryIds.length === 0) {
    const compose = await dumpComposeMap(paths)
    entryIds = compose.byName.get(name) ?? []
  }
  if (entryIds.length === 0) return { ok: false, detail: `找不到 ${name} 的 loader entry id，无法开关`, entryIds: [], restartRequired: false }
  const result = appendEntryOverrides(paths, name, entryIds, !enabled, enabled ? '兼容守卫：用户启用' : '兼容守卫：用户禁用')
  if (!result.ok) return { ok: false, detail: result.detail, entryIds: result.entryIds, restartRequired: false }
  state.disabledByGuard = state.disabledByGuard.filter((item) => item.name !== name)
  const live = profilePatchIsLive(paths)
  return {
    ok: true,
    detail: `已${enabled ? '启用' : '禁用'} ${name}（${result.entryIds.join(', ')}）${live ? '，DSH 正在热重组' : '，需要重启生效'}`,
    entryIds: result.entryIds,
    restartRequired: !live,
  }
}

/** 卸载 profile 依赖里的社区插件（官方 bundle / 注入插件不支持在这里卸载）。 */
export async function uninstallPlugin(
  paths: GuardPaths,
  state: GuardState,
  report: ScanReport,
  name: string,
  options: { allowSelf?: boolean } = {},
): Promise<{ ok: boolean; detail: string; restartRequired: boolean }> {
  if (name === SELF_PACKAGE && options.allowSelf !== true) {
    return { ok: false, detail: '兼容守卫不能在这里卸载自己', restartRequired: false }
  }
  const plugin = report.plugins.find((item) => item.name === name)
  if (plugin === undefined) return { ok: false, detail: `未找到插件 ${name}`, restartRequired: false }
  if (plugin.trust === 'system' || plugin.sourceKind === 'official') {
    return { ok: false, detail: '官方 bundle 不能在这里卸载', restartRequired: false }
  }
  if (plugin.trust === 'injected') {
    return { ok: false, detail: '这是运行时注入的插件，请用 super-injector 卸载', restartRequired: false }
  }
  const manifest = readJson(paths.profilePackageJson)
  const deps = (manifest?.dependencies ?? {}) as Record<string, unknown>
  if (typeof deps[name] !== 'string') {
    return { ok: false, detail: `${name} 不在 profile dependencies 里，无法用 dsh plugin remove`, restartRequired: false }
  }
  backupFiles(paths, [paths.profilePackageJson, paths.profilePatchFile, join(paths.profileDir, 'pnpm-lock.yaml')], `uninstall-${name.replace(/[\\/@]/g, '_')}`)
  const result = await runDshPlugin(paths, ['remove', name])
  if (result.code !== 0) {
    return { ok: false, detail: `卸载失败（exit=${result.code}）：${result.output}`, restartRequired: false }
  }
  state.disabledByGuard = state.disabledByGuard.filter((item) => item.name !== name)
  if (name === SELF_PACKAGE) {
    try {
      const pid = Number(readFileSync(paths.supervisorPidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    } catch { /* supervisor 不在或已退出 */ }
  }
  return {
    ok: true,
    detail: name === SELF_PACKAGE
      ? '兼容守卫已从 profile 移除（supervisor 已停止）；重启 DSH 后彻底消失'
      : `已从 profile 移除 ${name}，重启后彻底消失`,
    restartRequired: true,
  }
}
