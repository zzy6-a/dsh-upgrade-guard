import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface GuardPaths {
  dshHome: string
  profile: string
  profileDir: string
  profilesDir: string
  profilePackageJson: string
  profilePatchFile: string
  hostDir: string | null
  hostVersion: string | null
  guardDir: string
  stateFile: string
  logFile: string
  incidentsDir: string
  backupsDir: string
  snapshotsDir: string
  controlDir: string
  supervisorFile: string
  supervisorPidFile: string
  supervisorStatusFile: string
}

/** 从 argv 里解析当前 boot 的 profile（--profile x / --profile=x / web 别名）。 */
export function detectProfile(argv: string[] = process.argv): string {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--profile' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) return argv[i + 1]
    if (token.startsWith('--profile=')) return token.slice('--profile='.length)
  }
  if (argv.includes('web')) return 'web'
  return 'web'
}

function readManifest(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function isDshManifest(dir: string): string | null {
  const manifest = readManifest(join(dir, 'package.json'))
  if (manifest === null || manifest.name !== '@deepseek-ai/dsh') return null
  return typeof manifest.version === 'string' ? manifest.version : 'unknown'
}

/** 从 CLI 入口向上找宿主包目录（npm -g / Homebrew / nvm 都适用）。 */
function findHostDirFromEntry(entry: string | undefined): { dir: string; version: string } | null {
  if (entry === undefined || entry === '') return null
  let start: string
  try {
    start = dirname(realpathSync(entry))
  } catch {
    start = dirname(resolve(entry))
  }
  let dir = start
  for (let depth = 0; depth < 12; depth += 1) {
    const version = isDshManifest(dir)
    if (version !== null) return { dir, version }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 常见 npm 全局安装位置 + Electron/Desktop 打包位置兜底（跨平台）。 */
function hostDirCandidates(): string[] {
  const out: string[] = []
  const push = (value: string | undefined): void => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  push(process.env.DSH_HOST_DIR)
  const prefix = process.env.npm_config_prefix
  if (prefix !== undefined && prefix !== '') {
    if (process.platform === 'win32') {
      push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'))
      push(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    } else {
      push(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
      push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh'))
    }
  }
  if (process.platform === 'win32') {
    push(join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
    push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  } else {
    push('/usr/lib/node_modules/@deepseek-ai/dsh')
    push('/usr/local/lib/node_modules/@deepseek-ai/dsh')
    push(join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  // Electron / DSH Desktop：宿主包在 resources 下
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    for (const app of ['app.asar.unpacked', 'app.asar', 'app']) {
      push(join(resourcesPath, app, 'node_modules', '@deepseek-ai', 'dsh'))
    }
  }
  return out
}

function findHostDirFromKnownPaths(): { dir: string; version: string } | null {
  for (const candidate of hostDirCandidates()) {
    const version = isDshManifest(candidate)
    if (version !== null) return { dir: candidate, version }
  }
  return null
}

export function findHost(): { dir: string; version: string } | null {
  return findHostDirFromEntry(process.argv[1]) ?? findHostDirFromKnownPaths()
}

export function resolveGuardPaths(profileOverride?: string): GuardPaths {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? resolve(process.env.DSH_HOME)
    : join(homedir(), '.dsh')
  const profile = profileOverride ?? detectProfile()
  const profilesDir = join(dshHome, 'profiles')
  const profileDir = join(profilesDir, profile)
  const host = findHost()
  const guardDir = join(dshHome, 'upgrade-guard')
  return {
    dshHome,
    profile,
    profileDir,
    profilesDir,
    profilePackageJson: join(profileDir, 'package.json'),
    profilePatchFile: join(profileDir, 'cordis.patch.yml'),
    hostDir: host?.dir ?? null,
    hostVersion: host?.version ?? null,
    guardDir,
    stateFile: join(guardDir, 'state.json'),
    logFile: join(guardDir, 'guard.log'),
    incidentsDir: join(guardDir, 'incidents'),
    backupsDir: join(guardDir, 'backups'),
    snapshotsDir: join(guardDir, 'host-snapshots'),
    controlDir: join(guardDir, 'control'),
    supervisorFile: join(guardDir, 'supervisor.mjs'),
    supervisorPidFile: join(guardDir, 'supervisor.pid'),
    supervisorStatusFile: join(guardDir, 'supervisor-status.json'),
  }
}

export function readHostCoreVersion(hostDir: string | null, name: string): string | null {
  if (hostDir === null) return null
  const manifest = readManifest(join(hostDir, 'node_modules', name, 'package.json'))
  if (manifest !== null && typeof manifest.version === 'string') return manifest.version
  if (name === '@deepseek-ai/dsh') return isDshManifest(hostDir)
  return null
}

export function hostCoreInventory(hostDir: string | null): Map<string, string | null> {
  const inventory = new Map<string, string | null>()
  if (hostDir === null) return inventory
  if (existsSync(hostDir)) inventory.set('@deepseek-ai/dsh', isDshManifest(hostDir))
  const scopeDir = join(hostDir, 'node_modules', '@deepseek-ai')
  if (existsSync(scopeDir)) {
    try {
      for (const entry of readdirSafe(scopeDir)) {
        if (!/^(dsh|cordis)/.test(entry.name)) continue
        const manifest = readManifest(join(scopeDir, entry.name, 'package.json'))
        const version = manifest !== null && typeof manifest.version === 'string' ? manifest.version : null
        inventory.set(`@deepseek-ai/${entry.name}`, version)
      }
    } catch { /* ignore */ }
  }
  return inventory
}

function readdirSafe(path: string): Array<{ name: string }> {
  return readdirSync(path, { withFileTypes: true })
    .filter((item) => item.isDirectory() || item.isSymbolicLink())
    .map((item) => ({ name: item.name }))
}
