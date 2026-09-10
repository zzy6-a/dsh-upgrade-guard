#!/usr/bin/env node
/**
 * dsh-upgrade-guard supervisor —— 脱离 DSH 宿主生命周期运行的守护进程。
 *
 * 职责：
 *  1. adopt 当前 DSH（host.json 由宿主内插件每次启动写入）；
 *  2. 跟踪宿主版本，为每个版本保留一份完整目录快照（回滚用，无需 sudo/npm）；
 *  3. 宿主"快速崩溃"时解析启动日志 → 自动禁用故障 loader entry → 重启；
 *  4. 自动禁用仍救不回来 / 核心失败 → 直接用旧版快照启动（自动回滚）；
 *  5. 消费 control/restart.json，执行手动重启。
 *
 * 不做：改动宿主全局安装、npm 升级宿主、拦截升级。
 * 所有自动处置都会写 incidents/*.json，宿主恢复后由插件弹窗告知。
 */
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import net from 'node:net'

const argv = process.argv.slice(2)
function argValue(name, fallback) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] !== undefined) return argv[i + 1]
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1)
  }
  return fallback
}

const GUARD_DIR = argValue('--guard-dir', process.env.DSH_GUARD_DIR || join(homedir(), '.dsh', 'upgrade-guard'))
const POLL_MS = 2000
const QUICK_DEATH_MS = 60_000
const MAX_RESCUE = 3
const KEEP_SNAPSHOTS = 2
const PORT_WAIT_MS = 30_000

const PID_FILE = join(GUARD_DIR, 'supervisor.pid')
const STATUS_FILE = join(GUARD_DIR, 'supervisor-status.json')
const HOST_JSON = join(GUARD_DIR, 'host.json')
const CONTROL_DIR = join(GUARD_DIR, 'control')
const INCIDENTS_DIR = join(GUARD_DIR, 'incidents')
const SNAPSHOTS_DIR = join(GUARD_DIR, 'host-snapshots')
const BACKUPS_DIR = join(GUARD_DIR, 'backups')
const LOG_FILE = join(GUARD_DIR, 'supervisor.log')
const HOST_LOG = join(GUARD_DIR, 'host.log')

const state = {
  rescueAttempts: 0,
  rescueVersion: null,
  disabledPackages: new Set(),
  restartIntent: false,
  snapshotting: false,
}
const tracked = { pid: null, reg: null, adoptedAt: 0, child: null, spawnedByUs: false, exit: null }
let ticking = false

function nowIso() { return new Date().toISOString() }
function stamp() { return nowIso().replace(/[:.]/g, '-').slice(0, 19) }
function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }
function log(message) {
  try {
    ensureDir(GUARD_DIR)
    writeFileSync(LOG_FILE, `[${nowIso()}] ${message}\n`, { flag: 'a' })
  } catch { /* ignore */ }
}
function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}
function isAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function tailFile(file, maxBytes = 200_000) {
  try {
    const stat = statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try { readSync(fd, buffer, 0, length, start) } finally { closeSync(fd) }
    return buffer.toString('utf8')
  } catch { return '' }
}
function portOpen(port, timeout = 500) {
  if (typeof port !== 'number' || port <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value) }
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
    setTimeout(() => finish(false), timeout)
  })
}
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* ignore */ }
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
}

async function waitPortFree(port, timeoutMs) {
  if (typeof port !== 'number' || port <= 0) return true
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (!(await portOpen(port, 300))) return true
    await sleep(300)
  }
  return !(await portOpen(port, 300))
}
async function waitPortUp(port, timeoutMs) {
  if (typeof port !== 'number' || port <= 0) return null
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await portOpen(port, 400)) return true
    await sleep(500)
  }
  return await portOpen(port, 400)
}
function writeStatus(patch) {
  const previous = readJson(STATUS_FILE, {}) ?? {}
  writeJson(STATUS_FILE, {
    ...previous,
    ...patch,
    pid: process.pid,
    updatedAt: nowIso(),
  })
}
function writeIncident(incident) {
  ensureDir(INCIDENTS_DIR)
  const id = `${stamp()}-${incident.kind ?? 'incident'}`
  const file = join(INCIDENTS_DIR, `${id}.json`)
  writeJson(file, { id, at: nowIso(), consumed: false, ...incident })
  log(`incident ${incident.kind}: ${incident.title}`)
  return id
}

function parseFailure(text) {
  const re = /failed to apply loader entry\s+([^\s(]+)(?:\s*\(([^)]+)\))?/g
  let match
  let last = null
  while ((match = re.exec(text)) !== null) {
    const entry = match[1]
    if (entry === 'include' || entry === 'cordis:include') continue
    last = { entry, package: match[2] ?? entry }
  }
  return last
}

function snapshotDir(version) {
  return join(SNAPSHOTS_DIR, String(version ?? 'unknown').replace(/[^0-9A-Za-z._-]/g, '_'))
}
function pruneSnapshots() {
  try {
    const entries = readdirSync(SNAPSHOTS_DIR)
      .map((name) => join(SNAPSHOTS_DIR, name))
      .filter((dir) => existsSync(join(dir, '.complete')))
      .map((dir) => ({ dir, mtime: statSync(dir).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries.slice(KEEP_SNAPSHOTS)) rmSync(entry.dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}
async function ensureSnapshot(hostDir, version) {
  if (state.snapshotting || typeof hostDir !== 'string' || hostDir === '' || typeof version !== 'string' || version === '') return null
  const dir = snapshotDir(version)
  if (existsSync(join(dir, '.complete'))) return dir
  state.snapshotting = true
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    ensureDir(dirname(dir))
    try {
      cpSync(hostDir, dir, { recursive: true, force: true, dereference: false, verbatimSymlinks: true })
    } catch (firstError) {
      // Windows 下 junction/长路径可能让首次复制失败：降级为跟随链接复制
      log(`snapshot first pass failed, retry dereferenced: ${String(firstError)}`)
      rmSync(dir, { recursive: true, force: true })
      cpSync(hostDir, dir, { recursive: true, force: true, dereference: true })
    }
    writeFileSync(join(dir, '.complete'), nowIso(), 'utf8')
    log(`snapshot ${version} <- ${hostDir}`)
    pruneSnapshots()
    return dir
  } catch (error) {
    log(`snapshot failed: ${String(error)}`)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    return null
  } finally {
    state.snapshotting = false
  }
}
function findRollbackSnapshot(currentVersion) {
  try {
    return readdirSync(SNAPSHOTS_DIR)
      .map((name) => join(SNAPSHOTS_DIR, name))
      .filter((dir) => existsSync(join(dir, '.complete')) && existsSync(join(dir, 'lib', 'bin.js')))
      .map((dir) => ({ dir, mtime: statSync(dir).mtimeMs, version: dir.split(/[\\/]/).pop() }))
      .filter((entry) => entry.version !== currentVersion)
      .sort((a, b) => b.mtime - a.mtime)[0] ?? null
  } catch { return null }
}

function runCapture(file, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(file, args, { cwd, windowsHide: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr }) } })
    child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) } })
  })
}
async function dumpComposeMap(reg) {
  const byName = new Map()
  if (typeof reg?.bin !== 'string' || reg.bin === '') return byName
  const result = await runCapture(reg.node || process.execPath, [reg.bin, '--profile', reg.profile || 'web', '--dump-config'], reg.profileDir || process.cwd(), 60_000)
  let currentId = null
  for (const line of result.stdout.split(/\r?\n/)) {
    const idMatch = /^- id:\s*(\S+)\s*$/.exec(line)
    if (idMatch !== null) { currentId = idMatch[1]; continue }
    const nameMatch = /^\s{2,}name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (nameMatch !== null && currentId !== null) {
      const list = byName.get(nameMatch[1]) ?? []
      if (!list.includes(currentId)) list.push(currentId)
      byName.set(nameMatch[1], list)
      continue
    }
    if (/^\S/.test(line) && !line.startsWith('-')) currentId = null
  }
  return byName
}
function stripEmptyArray(content) {
  return content.split(/\r?\n/).filter((line) => line.trim() !== '[]').join('\n').replace(/\s+$/, '')
}
async function disablePackage(reg, packageName, reason) {
  const patchFile = reg.patchFile || join(reg.profileDir || '', 'cordis.patch.yml')
  if (!existsSync(patchFile)) return { ok: false, detail: `patch 文件不存在：${patchFile}`, ids: [], appended: '', backup: null }
  const compose = await dumpComposeMap(reg)
  const ids = compose.get(packageName) ?? []
  if (ids.length === 0) return { ok: false, detail: `dump-config 里找不到 ${packageName} 的 entry id，放弃自动禁用`, ids: [], appended: '', backup: null }
  const backupDir = join(BACKUPS_DIR, `${stamp()}-supervisor-disable-${packageName.replace(/[\\/@]/g, '_')}`)
  let backup = null
  try {
    ensureDir(backupDir)
    const target = join(backupDir, 'cordis.patch.yml')
    cpSync(patchFile, target)
    backup = target
  } catch { /* backup 失败仍可继续，但记录 */ }
  const appended = `\n# dsh-upgrade-guard supervisor disable ${packageName} at ${nowIso()} — ${reason}\n`
    + ids.map((id) => `- id: ${id}\n  disabled: true`).join('\n') + '\n'
  try {
    const original = readFileSync(patchFile, 'utf8')
    const base = stripEmptyArray(original)
    writeFileSync(patchFile, `${base === '' ? '' : `${base}\n`}${appended}`, 'utf8')
    return { ok: true, detail: `已禁用 ${ids.join(', ')}`, ids, appended, backup }
  } catch (error) {
    return { ok: false, detail: `写 patch 失败：${String(error)}`, ids, appended: '', backup }
  }
}

function spawnHost(reg) {
  ensureDir(GUARD_DIR)
  const out = openSync(HOST_LOG, 'a')
  const child = spawn(reg.node || process.execPath, [reg.bin, ...(reg.args ?? [])], {
    cwd: reg.cwd || process.cwd(),
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: process.env,
  })
  child.unref()
  tracked.pid = child.pid ?? null
  tracked.reg = reg
  tracked.adoptedAt = Date.now()
  tracked.child = child
  tracked.spawnedByUs = true
  tracked.exit = null
  child.on('exit', (code, signal) => { tracked.exit = { code, signal, at: nowIso() } })
  log(`spawned host pid=${child.pid} bin=${reg.bin} version=${reg.hostVersion ?? '?'}`)
  writeStatus({ mode: 'owned', targetPid: child.pid, hostVersion: reg.hostVersion ?? null })
  return child
}

function adopt(force = false) {
  const reg = readJson(HOST_JSON)
  if (!reg || !isAlive(reg.pid)) return false
  if (!force && tracked.pid === reg.pid) { tracked.reg = reg; return true }
  tracked.pid = reg.pid
  tracked.reg = reg
  tracked.adoptedAt = Date.now()
  tracked.child = null
  tracked.spawnedByUs = false
  tracked.exit = null
  if (state.rescueVersion !== (reg.hostVersion ?? null)) {
    state.rescueVersion = reg.hostVersion ?? null
    state.rescueAttempts = 0
  }
  writeStatus({ mode: 'watching', targetPid: reg.pid, hostVersion: reg.hostVersion ?? null })
  log(`adopted host pid=${reg.pid} version=${reg.hostVersion ?? '?'}`)
  if (reg.snapshotHost !== false) void ensureSnapshot(reg.hostDir, reg.hostVersion)
  return true
}

async function doRestart(command) {
  const reg = tracked.reg ?? readJson(HOST_JSON)
  if (!reg || typeof reg.bin !== 'string') {
    writeIncident({ kind: 'restart-failed', severity: 'error', title: '手动重启失败：缺少宿主注册信息', body: JSON.stringify(command ?? {}) })
    return
  }
  state.restartIntent = true
  log('manual restart requested')
  if (tracked.pid !== null && isAlive(tracked.pid)) {
    killTree(tracked.pid)
    const until = Date.now() + 15_000
    while (Date.now() < until && isAlive(tracked.pid)) await sleep(300)
    if (isAlive(tracked.pid)) killTree(tracked.pid)
  }
  await waitPortFree(reg.port, 15_000)
  await sleep(500)
  // 如果外部启动器已经拉起了新宿主，直接 adopt，避免双开
  const latest = readJson(HOST_JSON)
  if (latest && latest.pid !== tracked.pid && isAlive(latest.pid)) {
    adopt(true)
    state.restartIntent = false
    writeIncident({ kind: 'restart-done', severity: 'info', title: 'DSH 已由外部启动器重启', body: 'supervisor 已接管新宿主。' })
    return
  }
  const child = spawnHost(reg)
  const up = await waitPortUp(reg.port, PORT_WAIT_MS)
  state.restartIntent = false
  if (up === false) {
    writeIncident({ kind: 'restart-failed', severity: 'error', title: '手动重启后宿主未在 30 秒内监听端口', body: `pid=${child.pid}，请查看 ${HOST_LOG}` })
  } else if (up === true) {
    writeIncident({ kind: 'restart-done', severity: 'info', title: 'DSH 已重启', body: `新进程 pid=${child.pid}（supervisor 托管）。浏览器页面可能需要刷新。` })
  }
}

async function rollback(reg) {
  const currentVersion = reg.hostVersion ?? null
  const snapshot = findRollbackSnapshot(currentVersion)
  if (snapshot === null) {
    writeIncident({
      kind: 'rollback-unavailable',
      severity: 'error',
      title: '宿主启动失败，但找不到旧版快照，无法自动回滚',
      body: 'supervisor 还没有旧版本快照（通常需要经历一次"旧版本正常运行"才会生成）。请手动处理宿主或插件。',
    })
    tracked.pid = null
    writeStatus({ mode: 'blocked', currentRuntime: null })
    return
  }
  const nextReg = { ...reg, bin: join(snapshot.dir, 'lib', 'bin.js'), node: process.execPath, hostVersion: snapshot.version, logFile: HOST_LOG }
  writeIncident({
    kind: 'auto-rollback',
    severity: 'error',
    title: `宿主启动失败，已自动回滚到旧版 ${snapshot.version ?? '?'}`,
    body: `当前版本 ${currentVersion ?? '?'} 无法启动；已用快照 ${snapshot.dir} 启动旧版。\n回滚后插件兼容性状态可能变化，请查看设置页并按需修复插件；宿主升级仍可稍后手动重试。`,
    runtime: { version: snapshot.version, bin: nextReg.bin },
    actions: [{ id: 'check', label: '重新扫描', api: 'check' }, { id: 'restart', label: '重启旧版 DSH', api: 'restart' }],
  })
  log(`rollback -> ${snapshot.version} (${snapshot.dir})`)
  const child = spawnHost(nextReg)
  const up = await waitPortUp(nextReg.port, PORT_WAIT_MS)
  if (up === false) {
    writeIncident({ kind: 'rollback-failed', severity: 'error', title: '回滚启动失败：旧版宿主未监听端口', body: `pid=${child.pid}，请查看 ${HOST_LOG}` })
    tracked.pid = null
    writeStatus({ mode: 'blocked', currentRuntime: snapshot.version ?? null })
  } else if (up === true) {
    writeStatus({ mode: 'rolled-back', targetPid: child.pid, currentRuntime: snapshot.version ?? null })
  }
}

async function handleCrash() {
  const reg = tracked.reg ?? readJson(HOST_JSON) ?? {}
  const version = reg.hostVersion ?? null
  if (state.rescueVersion !== version) { state.rescueVersion = version; state.rescueAttempts = 0 }
  state.rescueAttempts += 1
  const text = tracked.spawnedByUs === true ? tailFile(HOST_LOG) : tailFile(reg.logFile || join(homedir(), '.dsh', 'logs', 'web.log'))
  const failure = parseFailure(text)
  log(`crash detected version=${version ?? '?'} attempt=${state.rescueAttempts} failure=${failure ? failure.package : 'unattributed'}`)
  if (failure && !state.disabledPackages.has(failure.package) && state.rescueAttempts <= MAX_RESCUE) {
    const disabled = await disablePackage(reg, failure.package, `启动失败自动禁用（attempt ${state.rescueAttempts}）`)
    if (disabled.ok) {
      state.disabledPackages.add(failure.package)
      writeIncident({
        kind: 'auto-disabled',
        severity: 'warning',
        title: `宿主启动失败，已自动禁用 ${failure.package}`,
        body: `loader entry "${failure.entry}" 应用失败。已写入 disabled patch 并重启宿主。\n\n备份：${disabled.backup ?? '无'}\n处置：${disabled.detail}`,
        actions: [
          { id: 'repair', label: '尝试修复该插件', api: 'repair', payload: { name: failure.package } },
          { id: 'restart', label: '重启 DSH', api: 'restart' },
        ],
        disabled: { name: failure.package, entryIds: disabled.ids, appended: disabled.appended, backup: disabled.backup, reason: '宿主启动失败自动禁用' },
      })
      const child = spawnHost(reg)
      const up = await waitPortUp(reg.port, PORT_WAIT_MS)
      if (up === false) log('rescue relaunch did not bind port')
      else await sleep(5000)
      if (!isAlive(child.pid)) log('rescue relaunch died again')
      return
    }
    writeIncident({ kind: 'rescue-failed', severity: 'error', title: `自动禁用 ${failure.package} 失败`, body: disabled.detail })
  }
  await rollback(reg)
}

async function tick() {
  if (ticking) return
  ticking = true
  try {
    const controlFile = join(CONTROL_DIR, 'restart.json')
    if (existsSync(controlFile)) {
      const command = readJson(controlFile, {})
      try { rmSync(controlFile, { force: true }) } catch { /* ignore */ }
      await doRestart(command)
      return
    }
    if (tracked.pid === null) { adopt(false); return }
    if (isAlive(tracked.pid)) {
      adopt(false)
      if (tracked.spawnedByUs && tracked.exit !== null) {
        // child 已退出但 pid 恰好被复用：交给下一轮的 dead 分支
      }
      return
    }
    const age = Date.now() - tracked.adoptedAt
    const childExit = tracked.exit
    const badExit = childExit !== null && childExit.code !== 0
    if (age < QUICK_DEATH_MS || badExit) {
      await handleCrash()
    } else {
      log('host exited after a stable run; supervisor standby')
      tracked.pid = null
      tracked.reg = null
      writeStatus({ mode: 'idle', targetPid: null })
    }
  } catch (error) {
    log(`tick error: ${String(error?.stack ?? error)}`)
  } finally {
    ticking = false
  }
}

function main() {
  ensureDir(GUARD_DIR)
  ensureDir(CONTROL_DIR)
  ensureDir(INCIDENTS_DIR)
  ensureDir(SNAPSHOTS_DIR)
  writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8')
  writeStatus({ mode: 'starting', startedAt: nowIso(), targetPid: null, currentRuntime: null })
  log(`supervisor started pid=${process.pid} guardDir=${GUARD_DIR}`)
  adopt(true)
  setInterval(() => { void tick() }, POLL_MS)
}

main()
