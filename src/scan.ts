import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyMismatch,
  compareSemver,
  satisfiesRange,
} from './semver.js'
import {
  corePackageNames,
  listInstalledPlugins,
  readManifestFacts,
  type InstalledPlugin,
} from './inventory.js'
import type { GuardPaths } from './paths.js'
import { asRecord, asString, nowIso } from './util.js'

export type IssueLevel = 'risk' | 'warning' | 'info'

export interface ScanIssue {
  level: IssueLevel
  code: string
  message: string
  declared?: string
  resolved?: string
  direction?: string
}

export interface PluginReport {
  name: string
  spec: string | null
  version: string | null
  description: string | null
  sourceKind: string
  trust: string
  dir: string | null
  isBundle: boolean
  status: 'ok' | 'warning' | 'risk' | 'broken' | 'disabled' | 'unknown'
  requirement: string | null
  entryIds: string[]
  fiberPhase: string | null
  issues: ScanIssue[]
}

export interface ScanReport {
  at: string
  trigger: 'boot' | 'host-upgrade' | 'manual'
  profile: string
  hostVersion: string | null
  hostDir: string | null
  total: number
  counts: { ok: number; warning: number; risk: number; broken: number; disabled: number; unknown: number }
  plugins: PluginReport[]
  notes: string[]
}

const FIBER_NAMES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']

interface LoaderEntryLike {
  options?: { id?: string; name?: string; disabled?: boolean }
  disabled?: boolean
  fiber?: { state?: number } | null
}

function fiberPhaseOf(entry: LoaderEntryLike): string {
  const state = entry.fiber?.state
  // active fiber 优先：热重载 bundle entry 时 loader 会把 options.disabled 置 true
  //（entry.disabled 是 getter），但 fiber 已重建为 active——此时插件实际生效。
  if (typeof state === 'number' && FIBER_NAMES[state] === 'active') return 'active'
  if (entry.disabled === true || entry.options?.disabled === true) return 'disabled'
  if (typeof state === 'number' && FIBER_NAMES[state] !== undefined) return FIBER_NAMES[state] as string
  if (entry.fiber === undefined || entry.fiber === null) return 'none'
  return 'unknown'
}

function displayRequirement(enginesDsh: string | null, peers: Record<string, string>): string | null {
  const parts: string[] = []
  if (enginesDsh !== null) parts.push(`engines.dsh ${enginesDsh}`)
  for (const [name, range] of Object.entries(peers)) {
    if (name === '@deepseek-ai/dsh' || /^@deepseek-ai\/dsh(?:-|$)/.test(name) || name === '@deepseek-ai/cordis') {
      parts.push(`${name} ${range}`)
    }
  }
  return parts.length === 0 ? null : parts.join(' ∩ ')
}

function evaluatePlugin(
  plugin: InstalledPlugin,
  hostVersion: string | null,
  hostCore: Map<string, string | null>,
  coreNames: Set<string>,
  loaderEntries: LoaderEntryLike[],
  shadowRoots: string[],
): PluginReport {
  const manifest = plugin.manifest
  const facts = readManifestFacts(manifest)
  const issues: ScanIssue[] = []
  const matched = loaderEntries.filter((entry) => {
    const name = entry.options?.name
    return typeof name === 'string' && name === plugin.name
  })
  const entryIds = matched.map((entry) => asString(entry.options?.id) ?? '?')
  const phase = matched.length === 0 ? null : (() => {
    const phases = matched.map((entry) => fiberPhaseOf(entry))
    if (phases.includes('active')) return 'active'
    if (phases.includes('failed')) return 'failed'
    if (phases.includes('pending')) return 'pending'
    if (phases.includes('disabled')) return 'disabled'
    return phases[0]
  })()
  const enabled = matched.length > 0 ? !matched.every((entry) => fiberPhaseOf(entry) === 'disabled') : null

  if (plugin.error !== null) {
    issues.push({ level: 'risk', code: 'resolve', message: plugin.error })
  }
  if (manifest === null && plugin.error === null) {
    issues.push({ level: 'risk', code: 'manifest', message: 'package.json 不可读' })
  }
  if (facts.enginesDsh !== null) {
    if (hostVersion === null) {
      issues.push({ level: 'info', code: 'engine-unknown', message: '无法定位宿主版本，engines.dsh 未判定', declared: facts.enginesDsh })
    } else {
      const satisfied = satisfiesRange(hostVersion, facts.enginesDsh)
      if (satisfied === false) {
        const verdict = classifyMismatch(facts.enginesDsh, hostVersion)
        const direction = verdict.kind === 'risk'
          ? verdict.direction
          : ((compareSemver(hostVersion, facts.enginesDsh) ?? 0) > 0 ? 'aboveMax' : 'belowMin')
        issues.push({
          level: 'risk',
          code: 'engine-mismatch',
          message: `engines.dsh 不满足：宿主 ${hostVersion}`,
          declared: facts.enginesDsh,
          resolved: hostVersion,
          direction,
        })
      } else if (satisfied === null) {
        issues.push({ level: 'warning', code: 'engine-unparseable', message: `engines.dsh 无法解析：${facts.enginesDsh}`, declared: facts.enginesDsh })
      }
    }
  }
  for (const [peerName, range] of Object.entries(facts.peerDependencies)) {
    const isHostPeer = peerName === '@deepseek-ai/dsh' || /^@deepseek-ai\/dsh(?:-|$)/.test(peerName) || peerName === '@deepseek-ai/cordis'
    if (!isHostPeer) continue
    const resolved = peerName === '@deepseek-ai/dsh' ? hostVersion : (hostCore.get(peerName) ?? null)
    if (resolved === null) {
      issues.push({ level: 'info', code: 'peer-unresolved', message: `宿主未提供 ${peerName}，无法判定`, declared: range })
      continue
    }
    const satisfied = satisfiesRange(resolved, range)
    if (satisfied === false) {
      const optional = facts.peerOptional[peerName] === true
      const verdict = classifyMismatch(range, resolved, optional)
      if (verdict.kind === 'risk') {
        issues.push({
          level: 'risk',
          code: 'peer-mismatch',
          message: `${peerName} 声明 ${range}，宿主提供 ${resolved}`,
          declared: range,
          resolved,
          direction: verdict.direction,
        })
      } else if (verdict.kind === 'warning') {
        issues.push({
          level: 'warning',
          code: verdict.reason === 'optional' ? 'peer-optional' : 'peer-above-max',
          message: `${peerName} 声明 ${range}，宿主提供 ${resolved}（${verdict.reason}）`,
          declared: range,
          resolved,
        })
      }
    } else if (satisfied === null) {
      issues.push({ level: 'warning', code: 'peer-unparseable', message: `${peerName} 范围无法解析：${range}`, declared: range })
    }
  }
  // core 包遮蔽：插件把宿主 core 当作普通依赖并且带了自己的副本
  // system（官方随宿主升级的 bundle）由宿主统一解析，不参与此判定
  const deps = plugin.trust === 'system' ? {} : (asRecord(manifest?.dependencies) ?? {})
  for (const depName of Object.keys(deps)) {
    if (!coreNames.has(depName)) continue
    const segments = depName.startsWith('@') ? depName.split('/') : [depName]
    const roots = [
      plugin.dir !== null ? join(plugin.dir, 'node_modules', ...segments) : '',
      ...shadowRoots.map((root) => join(root, 'node_modules', ...segments)),
    ].filter((item) => item !== '')
    if (roots.some((dir) => existsSync(join(dir, 'package.json')))) {
      issues.push({
        level: 'risk',
        code: 'core-shadow',
        message: `插件依赖了宿主 core 包 ${depName}，可能在运行时遮蔽宿主版本`,
        declared: String(deps[depName] ?? ''),
      })
    }
  }
  if (phase === 'failed') {
    issues.push({ level: 'risk', code: 'fiber-failed', message: 'Loader 中该插件 fiber 处于 failed 状态' })
  }
  if (phase === 'pending') {
    issues.push({ level: 'warning', code: 'fiber-pending', message: 'Loader 中该插件仍在 pending（等待服务）' })
  }

  const hasRisk = issues.some((issue) => issue.level === 'risk')
  const hasWarning = issues.some((issue) => issue.level === 'warning')
  const disabled = phase === 'disabled' || enabled === false
  const declaredSomething = facts.enginesDsh !== null || Object.keys(facts.peerDependencies).length > 0
  let status: PluginReport['status']
  if (plugin.error !== null || manifest === null) status = 'broken'
  else if (hasRisk) status = 'risk'
  else if (disabled) status = 'disabled'
  else if (hasWarning) status = 'warning'
  else if (!declaredSomething) status = 'unknown'
  else status = 'ok'

  return {
    name: plugin.name,
    spec: plugin.spec,
    version: plugin.version,
    description: typeof manifest?.description === 'string' && manifest.description.trim() !== ''
      ? manifest.description.trim().slice(0, 400)
      : null,
    sourceKind: plugin.sourceKind,
    trust: plugin.trust,
    dir: plugin.dir,
    isBundle: plugin.isBundle,
    status,
    requirement: displayRequirement(facts.enginesDsh, facts.peerDependencies),
    entryIds,
    fiberPhase: phase,
    issues,
  }
}

export function runScan(
  paths: GuardPaths,
  trigger: ScanReport['trigger'],
  loaderEntries: LoaderEntryLike[] = [],
): ScanReport {
  const plugins = listInstalledPlugins(paths)
  const hostCore = (() => {
    const map = new Map<string, string | null>()
    if (paths.hostDir !== null) {
      map.set('@deepseek-ai/dsh', paths.hostVersion)
      try {
        const scope = join(paths.hostDir, 'node_modules', '@deepseek-ai')
        if (existsSync(scope)) {
          for (const entry of readdirSync(scope, { withFileTypes: true })) {
            if (!/^(dsh|cordis)/.test(entry.name)) continue
            const manifestPath = join(scope, entry.name, 'package.json')
            try {
              const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
              map.set(`@deepseek-ai/${entry.name}`, typeof manifest.version === 'string' ? manifest.version : null)
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
    return map
  })()
  const coreNames = corePackageNames(paths)
  const shadowRoots = [paths.profileDir, paths.profilesDir]
  const reports = plugins.map((plugin) => evaluatePlugin(plugin, paths.hostVersion, hostCore, coreNames, loaderEntries, shadowRoots))
  const counts = { ok: 0, warning: 0, risk: 0, broken: 0, disabled: 0, unknown: 0 }
  for (const report of reports) counts[report.status] += 1
  const notes: string[] = []
  if (paths.hostVersion === null) notes.push('未能定位 DSH 宿主安装目录，版本类判定被跳过')
  if (plugins.length === 0) notes.push('profile 中没有发现已安装插件')
  return {
    at: nowIso(),
    trigger,
    profile: paths.profile,
    hostVersion: paths.hostVersion,
    hostDir: paths.hostDir,
    total: reports.length,
    counts,
    plugins: reports,
    notes,
  }
}
