// unplugin-ata core: build-time schema compilation, independent of any
// bundler. src/index.js wraps this in an unplugin; ata-vite delegates here.
//
// Schemas may be authored as .json (read as text), .js (native import), or
// .ts (loaded through jiti). For each schema matched by `schemas`, emit:
//   - <base>.validator.mjs      (self-contained validator)
//   - <base>.validator.d.mts    (TypeScript declarations, opt-in)
// or, for the `<name>.schema.json` convention, `<name>.schema.js` and
// `<name>.schema.d.ts` with the validate function as the default export.
//
// Output is written to disk, never served as virtual modules, so every
// bundler sees the same files and so does TypeScript.

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function pascal(str) {
  const cleaned = String(str)
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, '_$&')
  if (!cleaned) return 'Schema'
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

function deriveTypeName(schema, file, options) {
  if (schema && typeof schema.title === 'string' && schema.title.trim()) {
    return pascal(schema.title)
  }
  if (schema && typeof schema.$id === 'string' && schema.$id.trim()) {
    const base = path.basename(schema.$id).replace(/\.[^.]+$/, '')
    if (base) return pascal(base)
  }
  return options.nameFromFile(file)
}

const DEFAULT_OPTIONS = {
  schemas: '**/*.schema.json',
  outDir: null, // default: alongside each input
  format: 'esm',
  abortEarly: false,
  types: true,
  nameFromFile: (file) => {
    const base = path.basename(file, path.extname(file)).replace(/\.schema$/i, '')
    return pascal(base)
  },
}

async function loadAta() {
  // Resolve ata-validator at runtime so peer-dep works cleanly across package managers.
  // Standalone codegen comes from the ata-validator/build entry: the instance
  // method it replaced was removed in ata-validator 1.0.
  const mod = await import('ata-validator')
  const api = mod.default ?? mod
  const buildMod = await import('ata-validator/build')
  const build = buildMod.default ?? buildMod
  if (!api.Validator || !api.toTypeScript || typeof build.toStandaloneModule !== 'function') {
    throw new Error(
      'unplugin-ata requires ata-validator >= 0.19.0 with the ata-validator/build entry.',
    )
  }
  return { ...api, toStandaloneModule: build.toStandaloneModule }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [value]
}

async function resolveSchemaFiles(patterns, root) {
  const isVendor = (abs) =>
    path.relative(root, abs).split(path.sep).includes('node_modules')

  // Node 22+ ships fs.glob. Fall back to a recursive walk for older runtimes.
  if (typeof fs.glob === 'function') {
    const found = []
    for (const pattern of ensureArray(patterns)) {
      for await (const hit of fs.glob(pattern, { cwd: root })) {
        const abs = path.resolve(root, hit)
        if (!isVendor(abs)) found.push(abs)
      }
    }
    return [...new Set(found)]
  }

  const matched = new Set()
  for (const pattern of ensureArray(patterns)) {
    const anchor = path.resolve(root, pattern.split('*')[0] || '.')
    let stack
    try {
      const stat = await fs.stat(anchor)
      stack = stat.isDirectory() ? [anchor] : [path.dirname(anchor)]
    } catch {
      continue
    }
    const re = globToRegExp(pattern)
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') stack.push(abs)
          continue
        }
        const rel = path.relative(root, abs).split(path.sep).join('/')
        if (re.test(rel) && !isVendor(abs)) matched.add(abs)
      }
    }
  }
  return [...matched]
}

function globToRegExp(pattern) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    // `**/` matches zero or more path segments, so schemas/**/*.json
    // also picks up files that live directly in schemas/.
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(re + '$')
}

function isSchemaConvention(file) {
  return file.toLowerCase().endsWith('.schema.json')
}

function outputPaths(schemaFile, options, root) {
  const dir = options.outDir
    ? path.resolve(root, options.outDir, path.dirname(path.relative(root, schemaFile)))
    : path.dirname(schemaFile)
  if (isSchemaConvention(schemaFile)) {
    // user.schema.json -> base "user.schema" -> import './user.schema'
    const base = path.basename(schemaFile.replace(/\.json$/i, ''))
    const cjs = options.format === 'cjs'
    const mjs = path.join(dir, `${base}.${cjs ? 'cjs' : 'js'}`)
    const dts = path.join(dir, `${base}.${cjs ? 'd.cts' : 'd.ts'}`)
    return { dir, mjs, dts }
  }
  const base = path.basename(schemaFile, path.extname(schemaFile))
  const mjs = path.join(dir, `${base}.validator.${options.format === 'cjs' ? 'cjs' : 'mjs'}`)
  const dts = path.join(dir, `${base}.validator.${options.format === 'cjs' ? 'd.cts' : 'd.mts'}`)
  return { dir, mjs, dts }
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text)
}

// Vite normalizes resolve.alias to an array of { find, replacement } by the time
// configResolved runs, but accept the object form too. jiti's `alias` is a
// Record<string, string>, so only string finds carry over; RegExp finds are
// dropped (they cannot be expressed as a record key).
function normalizeAlias(viteAlias) {
  if (!viteAlias) return undefined
  const entries = Array.isArray(viteAlias)
    ? viteAlias
    : Object.entries(viteAlias).map(([find, replacement]) => ({ find, replacement }))
  const out = {}
  for (const { find, replacement } of entries) {
    if (typeof find === 'string' && typeof replacement === 'string') out[find] = replacement
  }
  return Object.keys(out).length ? out : undefined
}

// jiti instances are created on first .ts schema and reused, keyed by alias map
// so different alias sets do not share an instance. fsCache keeps transpilation
// on disk; moduleCache:false re-evaluates each import so HMR picks up edits.
// tsconfigPaths:true resolves TypeScript `paths` aliases from tsconfig.
const jitiInstances = new Map()
function getJiti(alias) {
  const key = alias ? JSON.stringify(alias) : ''
  let p = jitiInstances.get(key)
  if (!p) {
    p = (async () => {
      let mod
      try {
        mod = await import('jiti')
      } catch {
        throw new Error(
          'unplugin-ata: compiling .ts/.mts schema files needs "jiti". Install it with: npm install jiti',
        )
      }
      const createJiti = mod.createJiti ?? mod.default
      return createJiti(import.meta.url, {
        fsCache: true,
        moduleCache: false,
        tsconfigPaths: true,
        ...(alias ? { alias } : {}),
      })
    })()
    jitiInstances.set(key, p)
  }
  return p
}

// A schema module exports the schema as `default` (or a named `schema`).
// For CJS loaded over the ESM interop, `default` holds module.exports.
function pickSchema(mod) {
  return mod?.default ?? mod?.schema ?? mod
}

// JSON is read as inert text. JS goes through native import. TS goes through
// jiti. `fresh` busts the native module cache on the HMR/watch path only, so
// the one-shot buildStart keeps the registry clean.
async function loadSchema(file, fresh = false, alias) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.json' || ext === '') {
    return readJson(file)
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const url = pathToFileURL(file).href + (fresh ? `?t=${Date.now()}` : '')
    return pickSchema(await import(url))
  }
  const jiti = await getJiti(alias)
  return pickSchema(await jiti.import(file))
}

async function writeIfChanged(file, contents) {
  try {
    const existing = await fs.readFile(file, 'utf8')
    if (existing === contents) return false
  } catch { /* file missing, write fresh */ }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
  return true
}

async function compileOne(schemaFile, options, root, api, logger, fresh = false) {
  let schema
  try {
    schema = await loadSchema(schemaFile, fresh, options.alias)
  } catch (err) {
    logger?.warn?.(`[unplugin-ata] cannot load ${path.relative(root, schemaFile)}: ${err.message}`)
    return { changed: false, typeName: null, paths: null }
  }
  if (!schema || typeof schema !== 'object') {
    logger?.warn?.(`[unplugin-ata] ${path.relative(root, schemaFile)} did not export a schema object`)
    return { changed: false, typeName: null, paths: null }
  }

  const v = new api.Validator(schema)
  const validatorSrc = api.toStandaloneModule(v, { format: options.format, abortEarly: options.abortEarly })
  if (!validatorSrc) {
    logger?.warn?.(`[unplugin-ata] schema ${path.relative(root, schemaFile)} is too complex for standalone compilation`)
    return { changed: false, typeName: null, paths: null }
  }

  const typeName = deriveTypeName(schema, schemaFile, options)
  const paths = outputPaths(schemaFile, options, root)
  let outSrc = validatorSrc
  let defaultRewritten = false
  if (isSchemaConvention(schemaFile) && options.format !== 'cjs') {
    // toStandaloneModule emits `export default { validate, isValid, schemaHash };`
    // (schemaHash since ata-validator 1.25.0; earlier versions emit fewer names).
    // For the .schema convention we make the default the validate function so
    // `import validate from './x.schema'` works. Named exports stay intact, so
    // anything else in that object list is still importable by name.
    const replaced = outSrc.replace(
      /^export default \{\s*validate(?:\s*,\s*[A-Za-z_$][A-Za-z0-9_$]*)*\s*,?\s*\};?\s*$/m,
      'export default validate;',
    )
    if (replaced !== outSrc) {
      outSrc = replaced
      defaultRewritten = true
    } else {
      // ata's standalone output format changed: do NOT rewrite the .d.ts default
      // either, or the type would claim a callable default the module does not have.
      logger?.warn?.(`[unplugin-ata] could not set default export to validate for ${path.relative(root, schemaFile)} (ata output format changed); keeping the { validate, isValid } default`)
    }
  }
  const mjsChanged = await writeIfChanged(paths.mjs, outSrc)

  let dtsChanged = false
  if (options.types) {
    let dtsSrc = api.toTypeScript(schema, { name: typeName })
    // Only rewrite the .d.ts default when the .js default was actually rewritten,
    // so the declared default and the runtime default can never disagree.
    if (defaultRewritten) {
      dtsSrc = dtsSrc.replace(
        /^declare const _default:[^\n]*\nexport default _default;?\s*$/m,
        'export { validate as default };',
      )
    }
    dtsChanged = await writeIfChanged(paths.dts, dtsSrc)
  }

  return { changed: mjsChanged || dtsChanged, typeName, paths }
}

// Programmatic entry for custom build scripts.
export async function compile(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const root = options.root ?? process.cwd()
  const api = await loadAta()
  const files = await resolveSchemaFiles(opts.schemas, root)
  const results = await Promise.all(
    files.map((file) => compileOne(file, opts, root, api, null)),
  )
  return { files, results }
}

// One compilation session: a root, a logger, a lazily loaded ata, and the
// two operations a bundler hook needs.
export function createSession(userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions }
  let apiPromise = null
  const session = {
    options,
    root: userOptions.root ?? process.cwd(),
    logger: null,
    async compileAll() {
      const api = await (apiPromise ??= loadAta())
      const files = await resolveSchemaFiles(options.schemas, session.root)
      // Compile in parallel so reads, transpiles and writes overlap.
      const results = await Promise.all(
        files.map((file) => compileOne(file, options, session.root, api, session.logger)),
      )
      return { files, results }
    },
    async compileIfMatching(file) {
      if (!file) return null
      const api = await (apiPromise ??= loadAta())
      const files = await resolveSchemaFiles(options.schemas, session.root)
      if (!files.some((f) => path.resolve(f) === path.resolve(file))) return null
      // A change event: bypass the JS module cache so edits are seen.
      return compileOne(file, options, session.root, api, session.logger, true)
    },
  }
  return session
}

export { normalizeAlias, DEFAULT_OPTIONS }
export const __internal = { loadAta, resolveSchemaFiles, compileOne, outputPaths, globToRegExp, isSchemaConvention }
