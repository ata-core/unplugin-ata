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
import { readFileSync } from 'node:fs'
import * as fsSync from 'node:fs'
import { createRequire } from 'node:module'

// Whether every file @hookform/resolvers' export map gives for ./ata-validator
// has `name`. `entry` is the file `require` resolved to; the package root is
// the nearest folder above it whose package.json is @hookform/resolvers.
function resolverExportsAll (entry, name) {
  try {
    let dir = path.dirname(entry)
    let pkg
    for (;;) {
      try { pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { pkg = undefined }
      if (pkg && pkg.name === '@hookform/resolvers') break
      const up = path.dirname(dir)
      if (up === dir) return false
      dir = up
    }
    const targets = []
    const collect = (node) => {
      if (typeof node === 'string') { if (node.endsWith('.js') || node.endsWith('.mjs') || node.endsWith('.cjs')) targets.push(node) }
      else if (node && typeof node === 'object') for (const v of Object.values(node)) collect(v)
    }
    collect(pkg.exports && pkg.exports['./ata-validator'])
    if (targets.length === 0) targets.push(entry)
    return targets.every((t) => readFileSync(t === entry ? t : path.join(dir, t), 'utf8').includes(name))
  } catch {
    return false
  }
}

// `schemaOf<T>()`: the JSON Schema of a TypeScript type, read by the
// TypeScript checker through ts-json-schema-generator, both optional
// dependencies of this plugin. One generator per file that calls it, over
// that file and what it imports, with the compiler options of the nearest
// tsconfig.json above it (a program over the whole tsconfig would see every
// type of the project, and two types of one name in different files would
// be read as one); kept for the build, reset at build start so a type edited
// in watch mode is read again.
// JSDoc tags on the properties carry what a type cannot say (@format,
// @minimum, @pattern, @minLength, @maxItems, @asType integer). A type is a
// closed object unless the options say otherwise.
function createTypeSchemas (options = {}) {
  const generators = new Map()
  let mod = null
  let missing = null
  // The generator is loaded once, before the first transform that needs it
  // (the transform awaits ready()); schemaFor itself is synchronous, as the
  // compile-away pass is.
  const ready = async () => {
    if (mod || missing) return
    try { mod = await import('ts-json-schema-generator') } catch (e) { missing = e }
  }
  const tsconfigFor = (file) => {
    if (options.tsconfig) return path.resolve(options.tsconfig)
    let dir = path.dirname(path.resolve(file))
    for (;;) {
      const c = path.join(dir, 'tsconfig.json')
      try { if (fsSync.statSync(c).isFile()) return c } catch {}
      const up = path.dirname(dir)
      if (up === dir) return null
      dir = up
    }
  }
  const cache = new Map()
  return {
    ready,
    reset () { generators.clear(); cache.clear() },
    schemaFor (file, typeName) {
      if (!mod && !missing) throw new Error('schemaOf: the type-to-schema generator was not loaded before the transform (ready() was not awaited)')
      if (missing) {
        const err = new Error(`schemaOf<${typeName}>() in ${file} needs ts-json-schema-generator and typescript, which @ata-project/unplugin lists as optional: npm install -D ts-json-schema-generator typescript`)
        err.cause = missing
        throw err
      }
      const key = file + '\0' + typeName
      if (cache.has(key)) return cache.get(key)
      const tsconfig = tsconfigFor(file)
      const gkey = path.resolve(file)
      let gen = generators.get(gkey)
      if (!gen) {
        gen = mod.createGenerator({ path: gkey, tsconfig: tsconfig || undefined, type: '*', expose: 'none', topRef: false, skipTypeCheck: true, additionalProperties: options.additionalProperties === true, jsDoc: 'extended', ...(options.generator || {}) })
        generators.set(gkey, gen)
      }
      let schema
      try { schema = gen.createSchema(typeName) } catch (e) {
        const err = new Error(`schemaOf<${typeName}>() in ${file}: ${e.message.split('\n')[0]}`)
        err.cause = e
        throw err
      }
      // One document, as ata reads it: the generator's draft-07 by default.
      delete schema.$ref
      if (schema.definitions && Object.keys(schema.definitions).length === 0) delete schema.definitions
      cache.set(key, schema)
      return schema
    },
  }
}

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
  compileAway: true,
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
  // compiledModuleFor exists from ata-validator 1.35.0; compile-away needs it
  // and is skipped with a warning when it is missing.
  const canCompileAway = typeof build.compiledModuleFor === 'function' && typeof build.compiledSchemaFor === 'function'
  // The verdict-only wrapper, from ata-validator 1.40.0: code that never reads
  // errors gets it and the error pipeline stays out of the bundle.
  let compiledVerdict = false
  if (canCompileAway) {
    try { compiledVerdict = typeof (await import('ata-validator/compiled-verdict')).fromCompiledVerdict === 'function' } catch { compiledVerdict = false }
  }
  // The wrapper without the JSON entry points, from ata-validator 1.61.1: code
  // that reads errors but never calls validateJSON() or isValidJSON() gets it,
  // and the position map those use stays out of the bundle.
  // The plain wrapper, from 1.61.1: `new Validator(schema, { richErrors: false })`
  // is compiled away too, with no error pipeline in the bundle.
  let compiledPlain = false
  if (canCompileAway) {
    try { compiledPlain = typeof (await import('ata-validator/compiled-plain')).fromCompiledPlain === 'function' } catch { compiledPlain = false }
  }
  // The bare wrappers, from 1.61.1: a validator only ever called, never handed over.
  let compiledBare = false
  if (canCompileAway) {
    try { compiledBare = typeof (await import('ata-validator/compiled-bare')).barePlain === 'function' } catch { compiledBare = false }
  }
  let compiledBareRich = false
  if (canCompileAway) {
    try { compiledBareRich = typeof (await import('ata-validator/compiled-bare-rich')).bareRich === 'function' } catch { compiledBareRich = false }
  }
  let compiledObject = false
  if (canCompileAway) {
    try { compiledObject = typeof (await import('ata-validator/compiled-object')).fromCompiledObject === 'function' } catch { compiledObject = false }
  }
  // Whether the wrappers take a check registered with _extendChecks, as
  // withKeywords from @ata-project/keywords registers one; from 1.40.0. Asked
  // of a wrapper itself, so an ata-validator without it keeps such calls on
  // the runtime.
  // The ata-validator/t builder, run at build time on calls whose arguments
  // the build can read.
  let t = null
  if (canCompileAway) {
    try { const m = await import('ata-validator/t'); t = (m.default ?? m).t ?? m.t ?? null } catch { t = null }
  }
  let compiledExtendChecks = false
  // Whether the wrapper carries Standard Schema (`~standard`), from
  // ata-validator 1.60.0: then a validator handed to something that reads it
  // (a router's `body: v`, a form library) can be compiled away as well.
  let compiledStandard = false
  if (canCompileAway) {
    try {
      const c = await import('ata-validator/compiled')
      const fromCompiled = (c.default ?? c).fromCompiled ?? c.fromCompiled
      const w = fromCompiled({ validate: () => ({ valid: true, errors: [] }), isValid: () => true }, {}, { useDefaults: false })
      compiledExtendChecks = typeof w._extendChecks === 'function'
      compiledStandard = w['~standard'] !== undefined && typeof w['~standard'].validate === 'function' && w['~standard'].vendor === 'ata-validator'
    } catch { compiledExtendChecks = false; compiledStandard = false }
  }
  // Compact modules, from ata-validator 1.50.0: the verdict and the schema,
  // with errors from ata-validator/error-runtime, which the bundle then holds
  // once for every compact module in it.
  let compiledSharedErrors = false
  if (canCompileAway) {
    try { compiledSharedErrors = typeof (await import('ata-validator/error-runtime')).createErrors === 'function' } catch { compiledSharedErrors = false }
  }
  // Modules in the runtime's error order, from ata-validator 1.57.0: what
  // ataCompiledResolver needs, since it hands the module's errors to the form
  // as they come.
  let compiledOrder = false
  if (canCompileAway) {
    try { compiledOrder = (build.compiledModuleFor({ type: 'object', properties: { a: { type: 'string' } } }, { format: 'esm', order: true }) || '').includes('function _ataOrder(') } catch { compiledOrder = false }
  }
  // Whether the @hookform/resolvers a file imports has ataCompiledResolver,
  // asked of the copy that file resolves to, once per copy. Every file the
  // package's export map gives for ./ata-validator must have it: a bundler
  // takes the `import` one, `require` resolves the other, and a copy where
  // only one of them has it would build an import that does not exist.
  const resolverCopies = new Map()
  const compiledResolver = (file) => {
    if (!compiledOrder) return false
    let entry
    try { entry = createRequire(file).resolve('@hookform/resolvers/ata-validator') } catch { return false }
    let has = resolverCopies.get(entry)
    if (has === undefined) {
      has = resolverExportsAll(entry, 'ataCompiledResolver')
      resolverCopies.set(entry, has)
    }
    return has
  }
  // rjsf's own module writer from the @rjsf/validator-ata a file resolves to,
  // once per copy, or null: from 6.11.0, which has createPrecompiledValidator
  // under lib/ (an import that leaves the runtime validator out of the bundle),
  // and only where the ata-validator it compiles with writes its errors in the
  // runtime's order (bundleStandalone `order`, ata-validator 1.59.0), which the
  // form shows in its error list, and fills defaults before the check as rjsf's
  // runtime validator does (`useDefaults: true`, the same release). The writer
  // returned asks for both.
  const rjsfCopies = new Map()
  const rjsfCompiler = (file) => {
    if (!canCompileAway) return null
    let entry
    try { entry = createRequire(file).resolve('@rjsf/validator-ata/compileSchemaValidators') } catch { return null }
    let compile = rjsfCopies.get(entry)
    if (compile === undefined) {
      compile = null
      try {
        const req = createRequire(file)
        // The import the rewrite adds, as a bundler resolves it (the `import`
        // condition: lib/, beside dist/ where this resolved).
        const lib = path.join(path.dirname(entry), '..', 'lib', 'createPrecompiledValidator.js')
        if (!readFileSync(lib, 'utf8').includes('export default')) throw new Error('no ESM createPrecompiledValidator')
        const fn = req('@rjsf/validator-ata/compileSchemaValidators').compileSchemaValidatorsCode
        // rjsf passes its own options to bundleStandalone, and before 6.12 none
        // of the caller's: `order` and `useDefaults` are added on the
        // ata-validator copy rjsf loads, for the length of the call.
        const { Validator: RjsfValidator } = createRequire(entry)('ata-validator')
        const ordered = (schema) => {
          const own = Object.getOwnPropertyDescriptor(RjsfValidator, 'bundleStandalone')
          const bundle = RjsfValidator.bundleStandalone
          RjsfValidator.bundleStandalone = function (schemas, opts) { return bundle.call(this, schemas, { ...opts, order: true, useDefaults: true }) }
          try { return fn(schema) } finally {
            if (own) Object.defineProperty(RjsfValidator, 'bundleStandalone', own)
            else delete RjsfValidator.bundleStandalone
          }
        }
        const probe = typeof fn === 'function' ? ordered({ type: 'object', properties: { a: { type: 'string', minLength: 2, default: 'ab' } }, additionalProperties: false }) : ''
        if (/function _cpLen\(/.test(probe) && /function _ataOrder\(/.test(probe) && /\{applyDefaults\(d\);/.test(probe) && probe.includes('module.exports')) compile = ordered
      } catch { compile = null }
      rjsfCopies.set(entry, compile)
    }
    return compile
  }
  return {
    ...api,
    compiledResolver,
    rjsfCompiler,
    compiledSharedErrors,
    // The Bun target and the verification, from ata-validator 1.61.0.
    bunTarget: build.bunTarget && typeof build.bunTarget.schemaToBunType === 'function' ? build.bunTarget : null,
    verify: build.verify && typeof build.verify.verifySource === 'function' ? build.verify : null,
    toStandaloneModule: build.toStandaloneModule,
    compiledModuleFor: canCompileAway ? build.compiledModuleFor : null,
    compiledSchemaFor: canCompileAway ? build.compiledSchemaFor : null,
    // The Validator options fromCompiled() reproduces, from ata-validator
    // 1.37.0; before it, only calls without options are replaced.
    compiledOptions: canCompileAway && Array.isArray(build.compiledOptions) ? build.compiledOptions : [],
    compiledVerdict,
    compiledObject,
    compiledPlain,
    compiledBare,
    compiledBareRich,
    compiledExtendChecks,
    compiledStandard,
    t,
  }
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
  // options.onePass: the Bun entry sets it for an executable compiled ahead
  // of time, where the one-pass error function's size costs nothing.
  const validatorSrc = api.toStandaloneModule(v, { format: options.format, abortEarly: options.abortEarly, onePass: options.onePass ? true : undefined, source: options.onePass ? false : undefined })
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

  // The Bun target beside the module, for a build compiled ahead of time
  // (options.bunTarget, set by the Bun entry when the build has compile.aot):
  // the schema as a TypeScript type, the module's functions with the type on
  // them, and a typed parse(text); every check is this module's. An import of
  // the module is sent to the .bun.ts by the plugin's resolveId.
  let bunChanged = false
  if (options.bunTarget && api.bunTarget) {
    const written = await writeBunTargetBeside(schema, paths.mjs, typeName, options.format, api, defaultRewritten)
    bunChanged = written.changed
    paths.bun = written.bun
  }

  let dtsChanged = false
  if (options.types) {
    let dtsSrc = api.toTypeScript(schema, { name: typeName })
    // Bun's type checker reads this file for the import, not what the
    // plugin resolves it to; under the ahead-of-time build the import is the
    // .bun.ts beside the module, which also exports parse().
    if (paths.bun) dtsSrc += `\n// In a Bun build compiled ahead of time this import is the .bun.ts beside the module, which exports parse() as well.\nexport declare function parse(text: string): ${typeName} | null;\n`
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

  return { changed: mjsChanged || dtsChanged || bunChanged, typeName, paths }
}

// `<module>.bun.ts`, written beside a compiled module. Returns the path
// written, or `bun: null` when no type can be written for the schema (the
// module stands alone, as everywhere else).
async function writeBunTargetBeside (schema, modulePath, typeName, format, api, defaultIsValidate) {
  let mapped
  try { mapped = api.bunTarget.schemaToBunType(schema, { name: typeName }) } catch { return { changed: false, bun: null } }
  const ext = path.extname(modulePath)
  const bunPath = `${modulePath.slice(0, modulePath.length - ext.length)}.bun.ts`
  let text = api.bunTarget.toBunModule({
    schemaFile: path.basename(modulePath),
    moduleImport: './' + path.basename(modulePath),
    typeName: mapped.name,
    typeSource: mapped.type,
    aliases: mapped.aliases,
  })
  // The same default export as the module beside it.
  text += defaultIsValidate ? 'export default validate\n' : 'export default { validate, isValid }\n'
  const changed = await writeIfChanged(bunPath, text)
  return { changed, bun: bunPath }
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
    // `schemaOf<T>()` resolution, one per session; reset at build start.
    typeSchemas: createTypeSchemas(userOptions.types || {}),
    // Per file, what compileAway replaced and what it kept, for the report at
    // the end of the build.
    report: new Map(),
    // Schemas compiled away in this build, with the module source, for `verify`.
    verifying: new Map(),
    // Virtual module sources of an ahead-of-time build, by id.
    virtual: new Map(),
    async compileAll() {
      const api = await (apiPromise ??= loadAta())
      const files = await resolveSchemaFiles(options.schemas, session.root)
      // Compile in parallel so reads, transpiles and writes overlap.
      const results = await Promise.all(
        files.map((file) => compileOne(file, options, session.root, api, session.logger)),
      )
      return { files, results }
    },
    // ata-validator itself, loaded once for every hook that needs it.
    api() {
      return (apiPromise ??= loadAta())
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
export const __internal = { loadAta, resolveSchemaFiles, compileOne, outputPaths, globToRegExp, isSchemaConvention, createTypeSchemas }
