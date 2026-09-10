#!/usr/bin/env node
/**
 * Runs one plugin-declared probe in an isolated child process.
 * argv[2] = base64(JSON config). Prints __PROBE_RESULT__<json> on stdout.
 */
import { pathToFileURL } from 'node:url'

let result
try {
  const raw = process.argv[2] ?? ''
  const config = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  const url = pathToFileURL(config.probeFile)
  url.searchParams.set('t', String(Date.now()))
  const mod = await import(url.href)
  const fn = mod[config.exportName] ?? mod.default
  if (typeof fn !== 'function') throw new Error(`probe export is not a function: ${config.exportName}`)
  const value = await fn({
    hostVersion: config.hostVersion ?? null,
    profile: config.profile ?? null,
    dshHome: config.dshHome ?? null,
    pluginDir: config.pluginDir ?? null,
  })
  if (value !== null && typeof value === 'object') {
    result = { ok: value.ok !== false, message: value.message === undefined ? undefined : String(value.message) }
  } else {
    result = { ok: true }
  }
} catch (error) {
  const message = error !== null && typeof error === 'object' && 'stack' in error ? String(error.stack) : String(error)
  result = { ok: false, message: message.slice(0, 4000) }
}
process.stdout.write(`__PROBE_RESULT__${JSON.stringify(result)}\n`)
