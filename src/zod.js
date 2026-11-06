// The `zod` option: validators compiled from zod schemas, so a page keeps its
// zod source and carries neither zod nor a validator runtime. Each module the
// option names is loaded at build time (TypeScript through jiti), every export
// that is a zod 4 schema is turned into JSON Schema with zod's own
// `z.toJSONSchema`, and the result is written beside the module as
// `<name>.validators.mjs` and `.d.mts`: plain source, one `new Validator(schema)`
// per export, which a page's build compiles away like any other
// (src/compile-away.js). A server can import the same file and run it on the
// runtime.
//
//   ata({ zod: 'src/events/*.ts' })
//   import { widgetEvent } from './events/widget.validators.mjs'
//   widgetEvent.validate(event)
//
// Two choices are made for the page to answer as zod does:
//
// - The schema is the input schema (`io: 'input'`). `z.object` strips unknown
//   keys and passes; its output schema says `additionalProperties: false`, which
//   would refuse them. The input schema leaves objects open, so the verdict is
//   zod's; the keys are left in place rather than stripped. `z.strictObject`
//   stays closed either way.
// - Errors come in the plain shape (`richErrors: false`): keyword, path,
//   schema path, params and message, which is what a log line or a form
//   needs, and which keeps a one-schema page at about 1.1 KB gzipped where
//   the rich shape's presentation runtime makes it 2.9. `validatorOptions:
//   { richErrors: true }` asks for the rich shape.
// - Where zod writes both its own regex (`pattern`) and a `format` name for a
//   string (email, uuid, url, ...), the pattern alone is kept: zod's verdict
//   is its regex, and ata's format check beside it would reject what zod
//   accepts and carry a second checker for nothing.
// - A refinement, transform, pipe or preprocess has no JSON Schema form, and
//   `z.toJSONSchema` drops it without a word, even with `unrepresentable:
//   'throw'`. The build refuses such a schema by export and path, so a page
//   never accepts what the zod schema rejects. `dropRefinements: true` takes
//   them out knowingly, and the build says which ones; the server's zod still
//   runs them.

import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const pascal = (s) => s.replace(/(^|[^A-Za-z0-9])([a-z0-9])/g, (_, __, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')

export function entries(option) {
  const list = Array.isArray(option) ? option : [option]
  return list.filter(Boolean).map((e) => (typeof e === 'string' ? { files: e } : e))
}

const isZodSchema = (v) => v !== null && typeof v === 'object' && v._zod !== undefined && v._zod.def !== null && typeof v._zod.def === 'object'

// Walks a zod 4 definition for what JSON Schema cannot carry: a refine (a
// `custom` check), a transform, a pipe or preprocess around it. Returns
// `path: kind` strings. Lazy schemas are followed once.
export function unrepresentable(schema, at = '$', out = [], seen = new Set()) {
  if (!isZodSchema(schema) || seen.has(schema)) return out
  seen.add(schema)
  const def = schema._zod.def
  for (const c of def.checks || []) {
    const kind = c && c._zod && c._zod.def ? c._zod.def.check : null
    if (kind === 'custom') out.push(`${at}: refine`)
  }
  if (def.type === 'transform') out.push(`${at}: transform`)
  if (def.type === 'pipe') {
    const inner = def.in && def.in._zod ? def.in._zod.def.type : '?'
    if (inner === 'transform') out.push(`${at}: preprocess`)
    unrepresentable(def.in, at, out, seen); unrepresentable(def.out, at, out, seen)
  }
  if (def.type === 'custom') out.push(`${at}: custom`)
  if (def.shape) for (const k of Object.keys(def.shape)) unrepresentable(def.shape[k], `${at}.${k}`, out, seen)
  if (def.element) unrepresentable(def.element, `${at}[]`, out, seen)
  if (def.innerType) unrepresentable(def.innerType, at, out, seen)
  if (def.options) def.options.forEach((o, i) => unrepresentable(o, `${at}|${i}`, out, seen))
  if (def.items) def.items.forEach((o, i) => unrepresentable(o, `${at}[${i}]`, out, seen))
  if (def.rest) unrepresentable(def.rest, `${at}[...]`, out, seen)
  if (def.keyType) unrepresentable(def.keyType, `${at}{key}`, out, seen)
  if (def.valueType) unrepresentable(def.valueType, `${at}{}`, out, seen)
  if (def.left) unrepresentable(def.left, `${at}&0`, out, seen)
  if (def.right) unrepresentable(def.right, `${at}&1`, out, seen)
  if (def.type === 'lazy' && typeof def.getter === 'function') { try { unrepresentable(def.getter(), at, out, seen) } catch {} }
  return out
}

// zod as the module resolves it, so the conversion is the project's own zod.
async function loadZod(fromFile) {
  const req = createRequire(fromFile)
  let resolved
  try { resolved = req.resolve('zod') } catch { throw new Error(`unplugin-ata: zod: ${fromFile} needs "zod" installed beside it (zod 4, for z.toJSONSchema)`) }
  const m = await import(pathToFileURL(resolved).href)
  const z = m.z ?? m.default ?? m
  if (typeof z.toJSONSchema !== 'function') throw new Error(`unplugin-ata: zod: ${fromFile} resolves a zod without toJSONSchema; zod 4 is needed`)
  return z
}

// The module and its types for one zod module's exports. `typeImport` is
// the specifier the declarations import the zod module by, for a
// TypeScript source: the page's type is then zod's own input type,
// `z.input<typeof import('./widget.js').widgetEvent>`, the type the author
// already has as `z.infer`. A JavaScript source gives no type that way, so
// its type is written from the schema.
export function render(schemas, validatorOptions, toTypeScript, source, typeImport = null) {
  const opts = validatorOptions && Object.keys(validatorOptions).length ? ', ' + JSON.stringify(validatorOptions) : ''
  let js = `// Generated by @ata-project/unplugin from ${source}. Do not edit.\n// One validator per exported zod schema (the input schema); a page's build compiles each.\nimport { Validator } from 'ata-validator'\n\n`
  let dts = `// Generated by @ata-project/unplugin from ${source}. Do not edit.\n${typeImport ? "import type { z } from 'zod'\n" : ''}export interface ValidationError { keyword: string; instancePath: string; schemaPath: string; params: Record<string, unknown>; message: string; [field: string]: unknown }\nexport type Result<T> = { valid: true; data: T; errors: readonly never[] } | { valid: false; errors: ValidationError[] }\n\n`
  const taken = new Set()
  Object.keys(schemas).forEach((name, i) => {
    const ns = pascal(name)
    if (taken.has(ns)) throw new Error(`unplugin-ata: zod: two exports of ${source} would both be typed as ${ns}`)
    taken.add(ns)
    const text = JSON.stringify(schemas[name])
    const lit = text.includes('"__proto__"') ? `JSON.parse(${JSON.stringify(text)})` : text
    js += `const v${i} = new Validator(${lit}${opts})\nexport const ${name} = { validate: (data) => v${i}.validate(data), isValidObject: (data) => v${i}.isValidObject(data) }\n`
    if (typeImport) {
      dts += `export type ${ns}Input = z.input<typeof import(${JSON.stringify(typeImport)}).${name}>\nexport declare const ${name}: { validate(data: unknown): Result<${ns}Input>; isValidObject(data: unknown): data is ${ns}Input }\n\n`
      return
    }
    let types = 'export type Body = unknown'
    if (toTypeScript) {
      const t = toTypeScript(schemas[name], { name: 'Body' })
      const a = t.search(/^export (type|interface) /m); const b = t.indexOf('export interface ValidationError')
      if (a !== -1 && b > a) types = t.slice(a, b).trim()
    }
    dts += `export declare namespace ${ns} {\n${types.replace(/^/gm, '  ')}\n}\nexport type ${ns}Input = ${ns}.Body\nexport declare const ${name}: { validate(data: unknown): Result<${ns}Input>; isValidObject(data: unknown): data is ${ns}Input }\n\n`
  })
  return { js, dts }
}

// The JSON Schemas of one module's zod exports, or a thrown error naming
// what cannot be carried.
export async function schemasOf(file, mod, entry, log) {
  const names = Object.keys(mod).filter((k) => isZodSchema(mod[k]))
  if (!names.length) throw new Error(`unplugin-ata: zod: ${file} exports no zod schema (a zod 4 schema is an object with _zod)`)
  const z = await loadZod(file)
  const out = {}
  for (const name of names) {
    const schema = mod[name]
    const dropped = unrepresentable(schema)
    if (dropped.length) {
      if (!entry.dropRefinements) {
        throw new Error(`unplugin-ata: zod: ${path.basename(file)} export ${name}: ${dropped.join(', ')}. z.toJSONSchema drops these without a word, and a page would then accept what the zod schema rejects. Write the rule as a JSON Schema constraint (pattern, minimum, enum), move a transform after validation, or set dropRefinements: true to take them out knowingly.`)
      }
      if (log) log.warn(`unplugin-ata: zod: ${path.basename(file)} export ${name}: dropped ${dropped.join(', ')} (dropRefinements)`)
    }
    let json
    try {
      json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' })
    } catch (e) {
      throw new Error(`unplugin-ata: zod: ${path.basename(file)} export ${name}: ${e && e.message ? e.message : e}`)
    }
    delete json.$schema
    out[name] = patternOnly(json)
  }
  return out
}

// zod's regex is its verdict: where it stands beside a format name, the
// name goes, so the page checks what zod checks and nothing else.
function patternOnly(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) { node.forEach(patternOnly); return node }
  if (typeof node.pattern === 'string' && typeof node.format === 'string') delete node.format
  for (const k of Object.keys(node)) patternOnly(node[k])
  return node
}

// Write the validators for every module the option names. `resolveFiles`
// expands the globs; `importModule` loads a module's namespace (jiti for
// TypeScript). Returns the files written and the exports found.
export async function compileZod(option, root, write, resolveFiles, importModule, log, fresh = false) {
  let toTypeScript = null
  try { const m = await import('ata-validator'); toTypeScript = (m.default ?? m).toTypeScript } catch {}
  const out = []
  for (const entry of entries(option)) {
    const files = await resolveFiles(entry.files, root)
    for (const file of files) {
      if (/\.validators\.(mjs|d\.mts)$/.test(file)) continue
      const abs = path.resolve(root, file)
      const mod = await importModule(abs, fresh)
      const schemas = await schemasOf(abs, mod, entry, log)
      const vo = entry.validatorOptions || {}
      const opts = {}
      if (vo.richErrors !== true) opts.richErrors = false
      if (vo.useDefaults !== undefined) opts.useDefaults = !!vo.useDefaults
      const ext = path.extname(abs)
      const base = abs.slice(0, abs.length - ext.length)
      // TypeScript resolves './widget.js' to widget.ts under both the bundler
      // and the nodenext resolution; a .mts source is imported as .mjs.
      const typeImport = ext === '.ts' || ext === '.tsx' ? './' + path.basename(base) + '.js' : ext === '.mts' ? './' + path.basename(base) + '.mjs' : null
      const { js, dts } = render(schemas, opts, toTypeScript, path.basename(abs), typeImport)
      const changed = (await write(base + '.validators.mjs', js)) | (await write(base + '.validators.d.mts', dts))
      out.push({ file: abs, module: base + '.validators.mjs', exports: Object.keys(schemas), changed: !!changed })
    }
  }
  return out
}
