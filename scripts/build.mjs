#!/usr/bin/env node
/** 跨平台 host 构建：本地 tsc 编译 src → lib，并复制 supervisor 资产。 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const tsc = join(root, 'node_modules', '.bin', isWindows ? 'tsc.cmd' : 'tsc')
if (!existsSync(tsc)) {
  console.error('build: local tsc not found — run `npm install` first')
  process.exit(1)
}
const result = spawnSync(tsc, ['-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit', shell: isWindows })
if (result.status !== 0) process.exit(result.status ?? 1)
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'scripts', 'supervisor.mjs'), join(root, 'lib', 'supervisor.mjs'))
copyFileSync(join(root, 'scripts', 'probe-runner.mjs'), join(root, 'lib', 'probe-runner.mjs'))
console.log('=== Host build complete (scripts/build.mjs) ===')
