// What the build would do with a project, without building it: every
// `zodResolver(...)` and `new Validator(...)` call under a directory, whether
// the plugin compiles it away, and where it does not, why. It runs the
// plugin's own transform on each source file and throws the output away, so
// it says what a build says. Nothing is written.
import fs from 'node:fs'
import path from 'node:path'
import { unpluginFactory } from './index.js'

const SOURCE = /\.[cm]?[jt]sx?$/
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.cache'])

function sources (root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 12) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!e.isFile() || !SOURCE.test(e.name)) continue
      let code
      try { if (fs.statSync(p).size > 1 << 20) continue; code = fs.readFileSync(p, 'utf8') } catch { continue }
      if (code.includes('@hookform/resolvers/zod') || code.includes('ata-validator')) out.push([p, code])
    }
  }
  walk(root, 0)
  return out
}

// { files, zod: { compiled, kept: [{ file, line, reason }] }, validators: { compiled, kept }, failed: [{ file, error }] }
export async function scanProject (root, options = {}) {
  root = path.resolve(root)
  const lines = []
  const logger = { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) }
  const hooks = unpluginFactory({ ...options, root, verify: false, report: true, logger })
  await hooks.buildStart.call({})
  const files = sources(root)
  const failed = []
  for (const [file, code] of files) {
    if (!hooks.transformInclude(file)) continue
    try { await hooks.transform.call({}, code, file) } catch (e) { failed.push({ file: path.relative(root, file), error: String(e && e.message).split('\n')[0] }) }
  }
  await hooks.buildEnd.call({})
  const out = { files: files.length, zod: { compiled: 0, kept: [] }, validators: { compiled: 0, kept: [] }, failed }
  for (const [, m] of lines) {
    let x
    if ((x = /zodResolver: (\d+) of \d+ calls? compiled/.exec(m))) out.zod.compiled = Number(x[1])
    else if ((x = /compileAway: (\d+) validators? compiled/.exec(m))) out.validators.compiled = Number(x[1])
    else if ((x = /^\[unplugin-ata\] left as written: (.*?):(\d+|\?) (zodResolver\([^)]*\): .*)$/.exec(m))) out.zod.kept.push({ file: x[1], line: x[2], reason: x[3] })
    else if ((x = /^\[unplugin-ata\] kept on the runtime: (.*?):(\d+|\?) (.*)$/.exec(m))) out.validators.kept.push({ file: x[1], line: x[2], reason: x[3] })
  }
  return out
}

export function render (r) {
  const out = []
  const z = r.zod.compiled + r.zod.kept.length
  if (z) {
    out.push(`zodResolver: ${r.zod.compiled} of ${z} call${z === 1 ? '' : 's'} would be compiled at build time; zod leaves the files where every call is.`)
    for (const k of r.zod.kept) out.push(`  ${k.file}:${k.line}  ${k.reason}`)
  } else out.push('zodResolver: no call found.')
  const v = r.validators.compiled + r.validators.kept.length
  if (v) {
    out.push(`new Validator / ataResolver: ${r.validators.compiled} of ${v} would be compiled at build time.`)
    for (const k of r.validators.kept) out.push(`  ${k.file}:${k.line}  ${k.reason}`)
  }
  for (const f of r.failed) out.push(`  ${f.file}  could not be read: ${f.error}`)
  out.push(`${r.files} file${r.files === 1 ? '' : 's'} read. Nothing was written.`)
  return out.join('\n')
}
