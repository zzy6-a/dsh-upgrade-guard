import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asRecord, asString, readJson, readJsonValue } from './util.js'
import type { GuardPaths } from './paths.js'

export type SourceKind = 'npm' | 'git' | 'local' | 'official' | 'unknown'
export type Trust = 'community' | 'system' | 'injected'

export interface InstalledPlugin {
  name: string
  spec: string | null
  sourceKind: SourceKind
  trust: Trust
  dir: string | null
  version: string | null
  manifest: Record<string, unknown> | null
  error: string | null
  isBundle: boolean
  entryIds: string[]
  fiberPhase: string | null
  enabled: boolean | null
}

export interface PluginManifestFacts {
  version: string | null
  enginesDsh: string | null
  peerDependencies: Record<string, string>
  peerOptional: Record<string, boolean>
}

export function readManifestFacts(manifest: Record<string, unknown> | null): PluginManifestFacts {
  const engines = asRecord(manifest?.engines)
  const peers = asRecord(manifest?.peerDependencies)
  const peerMeta = asRecord(manifest?.peerDependenciesMeta)
  const peerDependencies: Record<string, string> = {}
  const peerOptional: Record<string, boolean> = {}
  for (const [name, range] of Object.entries(peers ?? {})) {
    const text = asString(range)
    if (text !== null) peerDependencies[name] = text
    const meta = asRecord(peerMeta?.[name])
    peerOptional[name] = meta?.optional === true
  }
  return {
    version: asString(manifest?.version),
    enginesDsh: asString(engines?.dsh),
    peerDependencies,
    peerOptional,
  }
}

export function classifySource(spec: string | null): SourceKind {
  if (spec === null) return 'official'
  const value = spec.trim()
  if (value.startsWith('link:') || value.startsWith('file:') || value.startsWith('.')) return 'local'
  if (/^(github:|git\+|git:|https?:\/\/.*\.git)/i.test(value)) return 'git'
  if (value === '*' || /^[\^~<>=]?\s*\d/.test(value) || /^\d/.test(value)) return 'npm'
  if (/^[a-z@]/i.test(value)) return 'npm'
  return 'unknown'
}

function packageDirExists(dir: string): boolean {
  try {
    return existsSync(join(dir, 'package.json'))
  } catch {
    return false
  }
}

function danglingLink(dir: string): boolean {
  try {
    return lstatSync(dir).isSymbolicLink() && !existsSync(join(dir, 'package.json'))
  } catch {
    return false
  }
}

export function resolvePackageDir(paths: GuardPaths, name: string, preferHost = false): { dir: string | null; error: string | null } {
  const segments = name.startsWith('@') ? name.split('/') : [name]
  const profileRoots = [
    join(paths.profileDir, 'node_modules', ...segments),
    join(paths.profilesDir, 'node_modules', ...segments),
    join(paths.dshHome, 'node_modules', ...segments),
  ]
  const hostRoot = paths.hostDir !== null ? join(paths.hostDir, 'node_modules', ...segments) : ''
  const roots = (preferHost && hostRoot !== '' ? [hostRoot, ...profileRoots] : [...profileRoots, hostRoot]).filter((item) => item !== '')
  for (const dir of roots) {
    if (packageDirExists(dir)) return { dir, error: null }
  }
  for (const dir of roots) {
    if (danglingLink(dir)) return { dir: null, error: `依赖目录是悬空链接：${dir}` }
  }
  return { dir: null, error: `未在 profile/host 的 node_modules 中找到 ${name}` }
}

function listBundles(profilePkg: Record<string, unknown> | null): string[] {
  const dsh = asRecord(profilePkg?.dsh)
  const profile = asRecord(dsh?.profile)
  const bundles = profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : []
}

function listInjected(paths: GuardPaths): Array<{ name: string; dir: string }> {
  const registryCandidates = [
    join(paths.dshHome, 'super-injector', 'registry.json'),
    join(paths.dshHome, 'super-injector', 'injected.json'),
  ]
  for (const file of registryCandidates) {
    const value = readJsonValue(file)
    const data = asRecord(value)
    const entries = Array.isArray(value) ? value : Array.isArray(data?.entries) ? data.entries : null
    if (entries === null) continue
    const result: Array<{ name: string; dir: string }> = []
    for (const raw of entries) {
      const record = asRecord(raw)
      const name = asString(record?.name)
      const dir = asString(record?.dir)
      if (name !== null && dir !== null) result.push({ name, dir })
    }
    if (result.length > 0) return result
  }
  return []
}

/** 枚举"已安装插件"：bundles + 声明 dsh.bundle 的依赖 + 注入器清单。 */
export function listInstalledPlugins(paths: GuardPaths): InstalledPlugin[] {
  const profilePkg = readJson(paths.profilePackageJson)
  const deps = asRecord(profilePkg?.dependencies) ?? {}
  const bundles = listBundles(profilePkg)
  const bundleSet = new Set(bundles)
  const injected = listInjected(paths)
  const injectedMap = new Map(injected.map((item) => [item.name, item.dir]))
  const names = new Set<string>([...bundles, ...Object.keys(deps), ...injectedMap.keys()])

  const result: InstalledPlugin[] = []
  for (const name of names) {
    const spec = typeof deps[name] === 'string' ? deps[name] as string : null
    const isBundleName = bundleSet.has(name)
    const injectedDir = injectedMap.get(name)
    const resolved = injectedDir !== undefined && packageDirExists(injectedDir)
      ? { dir: injectedDir, error: null }
      : resolvePackageDir(paths, name, spec === null)
    let manifest: Record<string, unknown> | null = null
    if (resolved.dir !== null) {
      try {
        manifest = JSON.parse(readFileSync(join(resolved.dir, 'package.json'), 'utf8')) as Record<string, unknown>
      } catch (error) {
        manifest = null
      }
    }
    const declaresBundle = asRecord(asRecord(manifest?.dsh)?.bundle)?.patch !== undefined
    const trust: Trust = injectedMap.has(name) ? 'injected' : (spec === null ? 'system' : 'community')
    result.push({
      name,
      spec,
      sourceKind: trust === 'injected' ? 'local' : classifySource(spec),
      trust,
      dir: resolved.dir,
      version: asString(manifest?.version),
      manifest,
      error: resolved.error,
      isBundle: isBundleName || declaresBundle,
      entryIds: [],
      fiberPhase: null,
      enabled: null,
    })
  }
  return result
}

/** 宿主 core 包清单（用于 core 遮蔽检查）。 */
export function corePackageNames(paths: GuardPaths): Set<string> {
  const names = new Set<string>([
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-loader',
  ])
  if (paths.hostDir !== null) {
    try {
      const manifest = readJson(join(paths.hostDir, 'package.json'))
      const deps = asRecord(manifest?.dependencies) ?? {}
      for (const name of Object.keys(deps)) {
        if (/^@deepseek-ai\/dsh(?:-|$)/.test(name) || /^@deepseek-ai\/cordis(?:-|$)/.test(name)) names.add(name)
      }
    } catch { /* ignore */ }
  }
  return names
}
