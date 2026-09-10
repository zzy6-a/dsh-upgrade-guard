import { homedir } from 'node:os'
import { join } from 'node:path'
import { readText } from './util.js'
import { compareSemver, parseSemver, satisfiesRange } from './semver.js'
import type { PluginManifestFacts } from './inventory.js'

export interface RegistryManifest {
  version: string
  enginesDsh: string | null
  peerDependencies: Record<string, string>
}

export interface UpdateChoice {
  latest: string | null
  compatible: string | null
  reason: string
}

function npmRegistry(): string {
  const env = process.env.npm_config_registry
  if (env !== undefined && env.trim() !== '') return env.trim().replace(/\/+$/, '')
  const npmrc = readText(join(homedir(), '.npmrc'))
  if (npmrc !== null) {
    for (const line of npmrc.split(/\r?\n/)) {
      const match = /^\s*registry\s*=\s*(\S+)\s*$/.exec(line)
      if (match !== null) return match[1].replace(/\/+$/, '')
    }
  }
  return 'https://registry.npmjs.org'
}

function encodedName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2f') : name
}

export interface RegistryListing {
  versions: Map<string, RegistryManifest>
  latest: string | null
}

/** 拉取 npm registry 的版本清单；失败返回 null。 */
export async function fetchRegistryManifests(name: string): Promise<RegistryListing | null> {
  const url = `${npmRegistry()}/${encodedName(name)}`
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-upgrade-guard' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return null
    const doc = await response.json() as {
      versions?: Record<string, Record<string, unknown>>
      'dist-tags'?: Record<string, string>
    }
    const versions = doc.versions ?? {}
    const result = new Map<string, RegistryManifest>()
    for (const [version, manifest] of Object.entries(versions)) {
      if (parseSemver(version) === null) continue
      const engines = manifest.engines as Record<string, unknown> | undefined
      const peers = manifest.peerDependencies as Record<string, unknown> | undefined
      const peerDependencies: Record<string, string> = {}
      for (const [peerName, range] of Object.entries(peers ?? {})) {
        if (peerName === '@deepseek-ai/dsh' || /^@deepseek-ai\/dsh(?:-|$)/.test(peerName) || peerName === '@deepseek-ai/cordis') {
          if (typeof range === 'string') peerDependencies[peerName] = range
        }
      }
      result.set(version, {
        version,
        enginesDsh: typeof engines?.dsh === 'string' ? engines.dsh : null,
        peerDependencies,
      })
    }
    if (result.size === 0) return null
    const latestTag = typeof doc['dist-tags']?.latest === 'string' ? doc['dist-tags'].latest : null
    return { versions: result, latest: latestTag }
  } catch {
    return null
  }
}

function candidateFactsSatisfied(facts: RegistryManifest, hostVersion: string | null, hostCore: Map<string, string | null>): boolean | null {
  const results: boolean[] = []
  if (facts.enginesDsh !== null) {
    if (hostVersion === null) return null
    const ok = satisfiesRange(hostVersion, facts.enginesDsh)
    if (ok === null) return null
    results.push(ok)
  }
  for (const [peerName, range] of Object.entries(facts.peerDependencies)) {
    const resolved = peerName === '@deepseek-ai/dsh' ? hostVersion : (hostCore.get(peerName) ?? null)
    if (resolved === null) return null
    const ok = satisfiesRange(resolved, range)
    if (ok === null) return null
    results.push(ok)
  }
  if (results.length === 0) return null
  return results.every(Boolean)
}

/**
 * 选"与当前宿主声明兼容的最高版本"，而不是盲目 latest。
 * - 有声明且满足宿主 → 候选；
 * - 完全没有声明 → 只在没有任何已声明候选时回退到 latest（并标注 unverified）。
 */
export function chooseCompatibleTarget(
  installed: string | null,
  manifests: Map<string, RegistryManifest>,
  hostVersion: string | null,
  hostCore: Map<string, string | null>,
  latestTag: string | null = null,
): UpdateChoice {
  const all = [...manifests.values()].filter((item) => parseSemver(item.version) !== null)
  const declared = all.filter((item) => item.enginesDsh !== null || Object.keys(item.peerDependencies).length > 0)
  const compatible = declared.filter((item) => candidateFactsSatisfied(item, hostVersion, hostCore) === true)
  compatible.sort((a, b) => (compareSemver(b.version, a.version) ?? 0))
  const latest = latestTag !== null && manifests.has(latestTag)
    ? latestTag
    : [...all].sort((a, b) => (compareSemver(b.version, a.version) ?? 0))[0]?.version ?? null
  const higher = compatible.filter((item) => installed === null || (compareSemver(item.version, installed) ?? 0) > 0)
  if (higher.length > 0) {
    return { latest, compatible: higher[0].version, reason: 'declared-compatible' }
  }
  if (compatible.length > 0) {
    return { latest, compatible: compatible[0].version, reason: 'compatible-not-newer' }
  }
  // 没有声明兼容的版本：如果 latest 也没声明，回退 latest（未经验证）
  if (latest !== null) {
    const latestFacts = manifests.get(latest)
    const latestIsUndeclared = latestFacts !== undefined
      && latestFacts.enginesDsh === null
      && Object.keys(latestFacts.peerDependencies).length === 0
    if (latestIsUndeclared) return { latest, compatible: latest, reason: 'unverified-latest' }
  }
  return { latest, compatible: null, reason: 'no-compatible-version' }
}

export { npmRegistry }
