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
// - A `.refine(fn)` whose function reads nothing but its own parameter (and
//   the language's globals) is carried: its text is written into the module
//   and run on the value at its place after the compiled check, with zod's
//   message and path. Of 337 refine calls in 195 public TypeScript files,
//   258 are such functions (2026-11-06). A `.transform(fn)` of the same
//   kind is carried too, applied to the value in place once the check has
//   passed, so `validate(data).data` is what zod's `parse` gives (93 of 153
//   transforms in the same files). One that closes over an outside name, a
//   `superRefine` or a transform that takes `ctx` (zod exposes no function
//   for the first, and the second can raise issues), a `preprocess` (it runs
//   before the schema, which the compiled check cannot) or a `pipe` into a
//   second schema (the input schema does not carry it), has no form a page
//   can carry, and `z.toJSONSchema` drops
//   it without a word even with `unrepresentable: 'throw'`. The build refuses
//   such a schema by export and path, so a page never accepts what the zod
//   schema rejects. `dropRefinements: true` takes them out knowingly, and the
//   build says which ones; the server's zod still runs them.

import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseExpression } from '@babel/parser'

const pascal = (s) => s.replace(/(^|[^A-Za-z0-9])([a-z0-9])/g, (_, __, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')

export function entries(option) {
  const list = Array.isArray(option) ? option : [option]
  return list.filter(Boolean).map((e) => (typeof e === 'string' ? { files: e } : e))
}

const isZodSchema = (v) => v !== null && typeof v === 'object' && v._zod !== undefined && v._zod.def !== null && typeof v._zod.def === 'object'

// Globals a refine may read; everything else it names is a closure.
const GLOBALS = new Set(['Number', 'Date', 'Math', 'RegExp', 'JSON', 'Object', 'Array', 'String', 'Boolean', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'Intl', 'Set', 'Map', 'URL', 'encodeURIComponent', 'decodeURIComponent', 'undefined', 'NaN', 'Infinity', 'Symbol', 'Error', 'BigInt', 'structuredClone', 'atob', 'btoa', 'Reflect'])

const TYPE_GUARD = { string: 's', number: 'n', int: 'n', bigint: 'n', object: 'o', array: 'a', boolean: 'b' }

// The names a function's text reads that it did not declare: none means the
// function can be written into another module as it is.
export function closesOver(text) {
  let fn
  try { fn = parseExpression(text, { plugins: ['typescript'] }) } catch { return ['(unparsed)'] }
  const declared = new Set(); const used = new Set(); const props = new Set()
  const walk = (n, cb) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach((x) => walk(x, cb)); return } cb(n); for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'extra' && k !== 'leadingComments' && k !== 'trailingComments' && k !== 'innerComments') walk(n[k], cb) }
  const bind = (p) => walk(p, (n) => { if (n.type === 'Identifier') declared.add(n.name) })
  walk(fn, (n) => {
    if (n.type === 'VariableDeclarator') bind(n.id)
    if (n.type === 'FunctionDeclaration' && n.id) declared.add(n.id.name)
    if (/Function/.test(n.type)) n.params.forEach(bind)
    if (n.type === 'CatchClause' && n.param) bind(n.param)
    if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') props.add(n.property)
    if ((n.type === 'ObjectProperty' || n.type === 'ObjectMethod') && !n.computed && n.key.type === 'Identifier' && !n.shorthand) props.add(n.key)
    if (n.type === 'ThisExpression') used.add('this')
  })
  walk(fn, (n) => { if (n.type === 'Identifier' && !props.has(n)) used.add(n.name) })
  return [...used].filter((u) => !declared.has(u) && !GLOBALS.has(u))
}

// One check of a node: a refine the page can carry goes to `refines` as an
// op at its location, in order; anything else is reported in `out`.
function refineCheck(c, at, out, refines, tokens, placed, guard) {
  const cd = c && c._zod && c._zod.def ? c._zod.def : null
  if (!cd || cd.check !== 'custom') return
  if (typeof cd.fn !== 'function') { out.push(`${at}: superRefine`); return }
  const text = cd.fn.toString()
  if (!placed) { out.push(`${at}: refine inside a union or record, which a page cannot place`); return }
  const outside = closesOver(text)
  if (outside.length) { out.push(`${at}: refine closes over ${outside.join(', ')}`); return }
  if (refines === null) return
  let message
  try { message = typeof cd.error === 'function' ? cd.error() : cd.error } catch { message = undefined }
  if (message !== null && typeof message === 'object') message = message.message
  if (message !== undefined && typeof message !== 'string') { out.push(`${at}: refine with a message that is not text`); return }
  const extra = Array.isArray(cd.path) ? cd.path : []
  if (!extra.every((p) => typeof p === 'string' || typeof p === 'number')) { out.push(`${at}: refine with a path that is not names`); return }
  refines.push({ at, tokens: tokens.slice(), kind: 'r', text, message, extra, guard })
}

// Walks a zod 4 definition for what JSON Schema cannot carry: a refine (a
// `custom` check), a transform, a pipe or preprocess around it. Returns
// `path: kind` strings in `out`, and in `refines` the refines a page can
// carry: their place as tokens (a property name, or null for each array
// element), the function's text, the message, the issue path and a type
// guard. Inside a union, intersection, record, tuple or lazy schema a refine
// cannot be placed, so it is reported, never carried. Lazy schemas are
// followed once.
export function unrepresentable(schema, at = '$', out = [], seen = new Set(), refines = null, tokens = [], placed = true) {
  if (!isZodSchema(schema) || seen.has(schema)) return out
  seen.add(schema)
  const def = schema._zod.def
  // A transform is a pipe whose out is the function: the in side first (its
  // own checks and any earlier transform), then the function, then the
  // checks written after it, which see the transformed value.
  if (def.type === 'pipe' && def.out && def.out._zod && def.out._zod.def.type === 'transform') {
    unrepresentable(def.in, at, out, seen, refines, tokens, placed)
    const fn = def.out._zod.def.transform
    const text = typeof fn === 'function' ? fn.toString() : ''
    if (typeof fn !== 'function') out.push(`${at}: transform`)
    else if (fn.length > 1) out.push(`${at}: transform takes ctx, which a page cannot answer`)
    else if (!placed) out.push(`${at}: transform inside a union or record, which a page cannot place`)
    else { const outside = closesOver(text); if (outside.length) out.push(`${at}: transform closes over ${outside.join(', ')}`); else if (refines !== null) refines.push({ at, tokens: tokens.slice(), kind: 't', text, guard: TYPE_GUARD[def.in._zod.def.type] || '' }) }
    for (const c of def.checks || []) refineCheck(c, at, out, refines, tokens, placed, '')
    return out
  }
  for (const c of def.checks || []) refineCheck(c, at, out, refines, tokens, placed, TYPE_GUARD[def.type] || '')
  if (def.type === 'transform') out.push(`${at}: transform`)
  if (def.type === 'pipe') {
    // A preprocess runs its function before the schema, which the compiled
    // check cannot; a pipe into a second schema checks what the input
    // schema does not carry. Neither has a form a page can carry.
    const inner = def.in && def.in._zod ? def.in._zod.def.type : '?'
    if (inner === 'transform') { out.push(`${at}: preprocess`); unrepresentable(def.out, at, out, seen); return out }
    // A pipe into a second schema: the in side's ops, then the second
    // schema as a compiled check of its own on the value as it stands, then
    // the second schema's refines and transforms, all at this place. The
    // check is written beside the main one and compiled away like it.
    if (!placed) { out.push(`${at}: pipe inside a union or record, which a page cannot place`); return out }
    unrepresentable(def.in, at, out, seen, refines, tokens, placed)
    if (refines !== null) refines.push({ at, tokens: tokens.slice(), kind: 'c', schema: def.out, guard: '' })
    unrepresentable(def.out, at, out, seen, refines, tokens, placed)
    // The checks written after the pipe hang on the pipe node itself.
    for (const c of def.checks || []) refineCheck(c, at, out, refines, tokens, placed, '')
    return out
  }
  if (def.type === 'custom') out.push(`${at}: custom`)
  const go = (sub, label, tok, ok) => unrepresentable(sub, label, out, seen, refines, tok === undefined ? tokens : [...tokens, tok], placed && ok)
  if (def.shape) for (const k of Object.keys(def.shape)) go(def.shape[k], `${at}.${k}`, k, true)
  if (def.element) go(def.element, `${at}[]`, null, true)
  if (def.innerType) go(def.innerType, at, undefined, true)
  if (def.options) def.options.forEach((o, i) => go(o, `${at}|${i}`, undefined, false))
  if (def.items) def.items.forEach((o, i) => go(o, `${at}[${i}]`, undefined, false))
  if (def.rest) go(def.rest, `${at}[...]`, undefined, false)
  if (def.keyType) go(def.keyType, `${at}{key}`, undefined, false)
  if (def.valueType) go(def.valueType, `${at}{}`, undefined, false)
  if (def.left) go(def.left, `${at}&0`, undefined, false)
  if (def.right) go(def.right, `${at}&1`, undefined, false)
  if (def.type === 'lazy' && typeof def.getter === 'function') { try { go(def.getter(), at, undefined, false) } catch {} }
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
// The refines a module carries, run on the value at their place after the
// compiled check passed, as zod runs a node's refinements after its own
// checks: the verdict is zod's. In an error list a refine's error appears
// only once the schema's own checks pass, where zod lists both at once.
const REFINE_RUNTIME = `const seg = (k) => String(k).replace(/~/g, '~0').replace(/\\//g, '~1')
const guard = { s: (v) => typeof v === 'string', n: (v) => typeof v === 'number', o: (v) => v !== null && typeof v === 'object' && !Array.isArray(v), a: Array.isArray, b: (v) => typeof v === 'boolean' }
function walkTo(data, tokens, i, at, cb, set) {
  if (i === tokens.length) { cb(data, at, set); return }
  const t = tokens[i]
  if (t === null) { if (Array.isArray(data)) for (let j = 0; j < data.length; j++) walkTo(data[j], tokens, i + 1, at + '/' + j, cb, (nv) => { data[j] = nv }) }
  else if (data !== null && typeof data === 'object' && !Array.isArray(data) && Object.prototype.hasOwnProperty.call(data, t) && data[t] !== undefined) walkTo(data[t], tokens, i + 1, at + '/' + seg(t), cb, (nv) => { data[t] = nv })
}
// ops at one place, in order: ['t', fn] transforms the value, ['r', fn,
// message, extra] checks it. With a setter, a transformed value is written
// back, as a filled default is; without one it only flows into later ops.
function runOps(v, at, ops, g, errors, set, tokens) {
  if (g && !guard[g](v)) return
  for (const op of ops) {
    if (op[0] === 't') { v = op[1](v); if (set) set(v); continue }
    if (op[0] === 'c') {
      if (!errors) { if (!op[1](v)) return false; continue }
      const r = op[2](v)
      if (!r.valid) for (const e of r.errors) errors.push({ ...e, instancePath: at + e.instancePath })
      continue
    }
    if (!op[1](v) && errors) errors.push({ keyword: 'refine', instancePath: at + op[3].map((p) => '/' + seg(p)).join(''), schemaPath: '#' + tokens.map((t) => t === null ? '/items' : '/properties/' + seg(t)).join('') + '/refine', params: {}, message: op[2] })
    else if (!op[1](v)) return false
  }
  return true
}
function refined(r, data, places) {
  if (!r.valid) return r
  const errors = []
  const box = { d: data }
  for (const [tokens, g, ops] of places) walkTo(box, ['d', ...tokens], 0, '', (v, at, set) => runOps(v, at.slice(2), ops, g, errors, set, tokens))
  return errors.length ? { valid: false, errors } : (box.d === data ? r : { valid: true, data: box.d, errors: r.errors })
}
function refinesOk(data, places) {
  for (const [tokens, g, ops] of places) { let ok = true; walkTo(data, tokens, 0, '', (v, at) => { if (ok && runOps(v, at, ops, g, null, null, tokens) === false) ok = false }); if (!ok) return false }
  return true
}
`

export function render(schemas, validatorOptions, toTypeScript, source, typeImport = null, refines = {}) {
  const opts = validatorOptions && Object.keys(validatorOptions).length ? ', ' + JSON.stringify(validatorOptions) : ''
  const anyRefine = Object.values(refines).some((l) => l && l.length)
  let js = `// Generated by @ata-project/unplugin from ${source}. Do not edit.\n// One validator per exported zod schema (the input schema); a page's build compiles each.${anyRefine ? '\n// Refinements are written in and run after the compiled check, on the value at their place.' : ''}\nimport { Validator } from 'ata-validator'\n\n${anyRefine ? REFINE_RUNTIME + '\n' : ''}`
  let dts = `// Generated by @ata-project/unplugin from ${source}. Do not edit.\n${typeImport ? "import type { z } from 'zod'\n" : ''}export interface ValidationError { keyword: string; instancePath: string; schemaPath: string; params: Record<string, unknown>; message: string; [field: string]: unknown }\nexport type Result<T> = { valid: true; data: T; errors: readonly never[] } | { valid: false; errors: ValidationError[] }\n\n`
  const taken = new Set()
  Object.keys(schemas).forEach((name, i) => {
    const ns = pascal(name)
    if (taken.has(ns)) throw new Error(`unplugin-ata: zod: two exports of ${source} would both be typed as ${ns}`)
    taken.add(ns)
    const text = JSON.stringify(schemas[name])
    const lit = text.includes('"__proto__"') ? `JSON.parse(${JSON.stringify(text)})` : text
    const rl = refines[name] || []
    if (rl.length) {
      // The ops of one place together, in the order the walk found them.
      const places = []
      let checks = ''; let c = 0
      for (const r of rl) {
        const key = JSON.stringify(r.tokens)
        let p = places.find((x) => x.key === key)
        if (!p) { p = { key, tokens: r.tokens, guard: r.guard, ops: [] }; places.push(p) }
        if (r.kind === 'c') {
          const t = JSON.stringify(r.json); const l = t.includes('"__proto__"') ? `JSON.parse(${JSON.stringify(t)})` : t
          checks += `const v${i}_${c} = new Validator(${l}${opts})\n`
          // Member calls only, so the build compiles this check away too.
          p.ops.push(`['c', (v) => v${i}_${c}.isValidObject(v), (v) => v${i}_${c}.validate(v)]`); c++
        } else p.ops.push(r.kind === 't' ? `['t', ${r.text}]` : `['r', ${r.text}, ${JSON.stringify(r.message === undefined ? 'Invalid input' : r.message)}, ${JSON.stringify(r.extra)}]`)
      }
      const list = places.map((p) => `[${JSON.stringify(p.tokens)}, ${JSON.stringify(p.guard)}, [${p.ops.join(', ')}]]`).join(',\n  ')
      js += `const v${i} = new Validator(${lit}${opts})\n${checks}const r${i} = [\n  ${list}\n]\nexport const ${name} = { validate: (data) => refined(v${i}.validate(data), data, r${i}), isValidObject: (data) => v${i}.isValidObject(data) && refinesOk(data, r${i}) }\n`
    } else {
      js += `const v${i} = new Validator(${lit}${opts})\nexport const ${name} = { validate: (data) => v${i}.validate(data), isValidObject: (data) => v${i}.isValidObject(data) }\n`
    }
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
export async function schemasOf(file, mod, entry, log, refinesOut = null) {
  const names = Object.keys(mod).filter((k) => isZodSchema(mod[k]))
  if (!names.length) throw new Error(`unplugin-ata: zod: ${file} exports no zod schema (a zod 4 schema is an object with _zod)`)
  const z = await loadZod(file)
  const out = {}
  for (const name of names) {
    const schema = mod[name]
    const carried = []
    const dropped = unrepresentable(schema, '$', [], new Set(), carried)
    if (refinesOut !== null) refinesOut[name] = carried
    if (dropped.length) {
      if (!entry.dropRefinements) {
        throw new Error(`unplugin-ata: zod: ${path.basename(file)} export ${name}: ${dropped.join(', ')}. z.toJSONSchema drops these without a word, and a page would then accept what the zod schema rejects. Write the rule as a JSON Schema constraint (pattern, minimum, enum), move a transform after validation, or set dropRefinements: true to take them out knowingly.`)
      }
      if (log) log.warn(`unplugin-ata: zod: ${path.basename(file)} export ${name}: dropped ${dropped.join(', ')} (dropRefinements)`)
    }
    const convert = (s) => {
      let json
      try {
        json = z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' })
      } catch (e) {
        throw new Error(`unplugin-ata: zod: ${path.basename(file)} export ${name}: ${e && e.message ? e.message : e}`)
      }
      delete json.$schema
      return patternOnly(json)
    }
    out[name] = convert(schema)
    // The second schema of each pipe, as JSON for a check of its own.
    for (const op of carried) if (op.kind === 'c') { op.json = convert(op.schema); delete op.schema }
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
      const refines = {}
      const schemas = await schemasOf(abs, mod, entry, log, refines)
      const vo = entry.validatorOptions || {}
      const opts = {}
      if (vo.richErrors !== true) opts.richErrors = false
      if (vo.useDefaults !== undefined) opts.useDefaults = !!vo.useDefaults
      const ext = path.extname(abs)
      const base = abs.slice(0, abs.length - ext.length)
      // TypeScript resolves './widget.js' to widget.ts under both the bundler
      // and the nodenext resolution; a .mts source is imported as .mjs.
      const typeImport = ext === '.ts' || ext === '.tsx' ? './' + path.basename(base) + '.js' : ext === '.mts' ? './' + path.basename(base) + '.mjs' : null
      const { js, dts } = render(schemas, opts, toTypeScript, path.basename(abs), typeImport, refines)
      const changed = (await write(base + '.validators.mjs', js)) | (await write(base + '.validators.d.mts', dts))
      out.push({ file: abs, module: base + '.validators.mjs', exports: Object.keys(schemas), changed: !!changed })
    }
  }
  return out
}
