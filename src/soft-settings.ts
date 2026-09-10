import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GuardPaths } from './paths.js'

export const SOFT_SETTINGS_NS = 'upgrade-guard'

export interface SoftSettingsValue {
  enabled: boolean
  autoScan: boolean
}

export function normalizeSoft(value: unknown): SoftSettingsValue {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: record.enabled !== false,
    autoScan: record.autoScan !== false,
  }
}

/**
 * 从 profile 的 node_modules 解析宿主的 schemastery。
 * 插件目录在 profile 之外，顶层 import 解析不到 profile 级 hoist 的宿主包，
 * 必须借助 createRequire(profile/package.json) 走 profile 的解析路径。
 */
export async function loadSchemastery(paths: GuardPaths): Promise<any | null> {
  for (const anchor of [join(paths.profileDir, 'package.json'), join(paths.profilesDir, 'noop.js')]) {
    try {
      const requireFromProfile = createRequire(anchor)
      const entry = requireFromProfile.resolve('@deepseek-ai/schemastery')
      const mod = await import(pathToFileURL(entry).href)
      const schema = (mod as { default?: unknown }).default ?? mod
      if (schema !== null && schema !== undefined) return schema
    } catch { /* try next anchor */ }
  }
  return null
}
