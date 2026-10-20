// Compile-away: `new Validator(schema)` from ata-validator, with a schema the
// build can read, becomes a validator compiled at build time, so the runtime
// compiler stays out of the bundle. The source is left as the author wrote it;
// only the emitted module changes.
//
// A call is replaced only when every one of these holds, and left alone
// otherwise, so turning this on can cost a saving but not change behaviour:
//   - `Validator` is a named import from 'ata-validator', declared once;
//   - the call has exactly one argument, and that argument is a value the
//     build can read without running code: an object literal, a top-level
//     `const` bound to one, the default import of a relative `.json` file, or
//     `defineSchema(...)` around any of those;
//   - the result is assigned to a `const` declared once in the file, not
//     exported, and every other use of that name calls validate(),
//     isValidObject(), validateJSON() or isValidJSON() on it;
//   - ata-validator's compiledModuleFor() returns a module for the schema. It
//     declines schemas the replacement would not answer exactly as the runtime
//     does (custom error messages, shapes its error generator cannot express),
//     and ata's own test suite holds the rest to the runtime's results. The
//     wrapper gets the schema as the runtime reads it, compiledSchemaFor(), so
//     it fills defaults and orders errors the same way.
// The compiled module is inlined as a function scope next to the imports; it
// imports nothing, so no virtual module or extra file is involved.
//
// `ataResolver(schema)` from @hookform/resolvers/ata-validator becomes
// `ataCompiledResolver(module)` the same way, where the installed resolvers
// have it and ata-validator writes modules in the runtime's error order:
//   - the schema is a value the build can read, as above, and the call passes
//     no validator options (nothing reproduces coerceTypes or the like in a
//     module), or passes `undefined` or `{}` for them and a literal
//     `{ raw: <boolean> }` for the resolver's own options;
//   - compiledModuleFor() returns a module for the schema, written with
//     `order: true`, so its errors come in the runtime's order, and it exports
//     applyDefaults where the schema has a default, which the compiled resolver
//     calls first, as the runtime fills defaults. The resolver then answers as
//     ataResolver does; the resolvers' own tests hold the two to each other.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { parse } from '@babel/parser'
import MagicString from 'magic-string'

const METHODS = new Set(['validate', 'isValidObject', 'validateJSON', 'isValidJSON'])
const NOT_STATIC = Symbol('not static')
// The builders of ata-validator/t that take only values. refine and
// recursive take a function and stay on the runtime.
const T_PURE = new Set(['string', 'number', 'integer', 'boolean', 'null', 'literal', 'const', 'enum', 'array', 'tuple', 'record', 'object', 'optional', 'union', 'intersect', 'ref', 'any', 'unknown', 'never', 'pick', 'omit', 'partial', 'required', 'composite'])

// Keys that hold child nodes. Types are left out on purpose: they are erased
// before anything runs, so a name used in a type annotation says nothing about
// how the value is used.
function children(node) {
  const out = []
  for (const key in node) {
    if (key === '__parent' || key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
    if (key === 'typeAnnotation' || key === 'returnType' || key === 'typeParameters' || key === 'superTypeParameters' || key === 'implements') continue
    const v = node[key]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push([c, key]) }
    else if (v && typeof v.type === 'string') out.push([v, key])
  }
  return out
}

function isTypeOnly(node) {
  return node.type.startsWith('TS') && !['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSParameterProperty'].includes(node.type)
}

// Every binding a pattern introduces.
function bindingNames(pattern, out) {
  if (!pattern) return out
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break
    case 'ObjectPattern': for (const p of pattern.properties) bindingNames(p.type === 'RestElement' ? p.argument : p.value, out); break
    case 'ArrayPattern': for (const e of pattern.elements) bindingNames(e, out); break
    case 'AssignmentPattern': bindingNames(pattern.left, out); break
    case 'RestElement': bindingNames(pattern.argument, out); break
    case 'TSParameterProperty': bindingNames(pattern.parameter, out); break
  }
  return out
}

// One walk: how many times each name is declared anywhere in the file, and
// every identifier in a value position together with its parent.
function scan(ast) {
  const declared = new Map()
  const refs = []
  const declare = (name) => declared.set(name, (declared.get(name) || 0) + 1)
  const visit = (node, parent, key) => {
    if (isTypeOnly(node)) return
    switch (node.type) {
      case 'VariableDeclarator': for (const n of bindingNames(node.id, [])) declare(n); break
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ObjectMethod': case 'ClassMethod': case 'ClassPrivateMethod':
        if (node.id && node.type !== 'FunctionExpression') declare(node.id.name)
        if (node.type === 'FunctionExpression' && node.id) declare(node.id.name)
        for (const p of node.params) for (const n of bindingNames(p, [])) declare(n)
        break
      case 'ClassDeclaration': case 'ClassExpression': if (node.id) declare(node.id.name); break
      case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': declare(node.local.name); break
      case 'CatchClause': for (const n of bindingNames(node.param, [])) declare(n); break
      case 'Identifier': {
        const binding = parent && ((parent.type === 'VariableDeclarator' && key === 'id') || (key === 'params') || ((parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier')) || ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && key === 'id'))
        const propertyName = parent && (((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) || ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassProperty' || parent.type === 'ClassMethod') && key === 'key' && !parent.computed && !parent.shorthand) || parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement' || (parent.type === 'ImportSpecifier' && key === 'imported') || (parent.type === 'ExportSpecifier' && key === 'exported'))
        if (!binding && !propertyName) refs.push({ node, parent, key })
        return
      }
    }
    for (const [child, k] of children(node)) { child.__parent = node; visit(child, node, k) }
  }
  visit(ast.program, null, null)
  return { declared, refs }
}

// The value an expression stands for, when reading it needs no code to run.
function staticValue(node, ctx, seen = new Set()) {
  switch (node.type) {
    case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'TSTypeAssertion': case 'ParenthesizedExpression':
      return staticValue(node.expression, ctx, seen)
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return node.value
    case 'NullLiteral': return null
    case 'TemplateLiteral': return node.expressions.length === 0 ? node.quasis[0].value.cooked : NOT_STATIC
    case 'UnaryExpression': return node.operator === '-' && node.argument.type === 'NumericLiteral' ? -node.argument.value : NOT_STATIC
    case 'ArrayExpression': {
      const out = []
      for (const el of node.elements) {
        if (!el || el.type === 'SpreadElement') return NOT_STATIC
        const v = staticValue(el, ctx, seen)
        if (v === NOT_STATIC) return NOT_STATIC
        out.push(v)
      }
      return out
    }
    case 'ObjectExpression': {
      const out = {}
      for (const p of node.properties) {
        if (p.type !== 'ObjectProperty' || p.computed) return NOT_STATIC
        const k = p.key.type === 'Identifier' ? p.key.name : (p.key.type === 'StringLiteral' || p.key.type === 'NumericLiteral') ? String(p.key.value) : null
        if (k === null || k === '__proto__') return NOT_STATIC
        const v = staticValue(p.value, ctx, seen)
        if (v === NOT_STATIC) return NOT_STATIC
        out[k] = v
      }
      return out
    }
    case 'Identifier': {
      if (seen.has(node.name) || ctx.declared.get(node.name) !== 1) return NOT_STATIC
      const source = ctx.constants.get(node.name)
      if (!source) return NOT_STATIC
      seen.add(node.name)
      const v = source.json !== undefined ? source.json() : staticValue(source.init, ctx, seen)
      seen.delete(node.name)
      return v
    }
    case 'CallExpression': {
      if (node.callee.type === 'Identifier' && node.callee.name === ctx.defineSchema && node.arguments.length === 1) return staticValue(node.arguments[0], ctx, seen)
      // `t.object(...)` and the rest of the builder from ata-validator/t. It
      // returns plain JSON Schema and holds no state, so a call whose
      // arguments the build can read gives here what it gives at run time.
      // The builders that take a function are left out.
      const c = node.callee
      if (ctx.t && ctx.tName && c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' &&
          c.object.name === ctx.tName && ctx.declared.get(ctx.tName) === 1 && c.property.type === 'Identifier' && T_PURE.has(c.property.name) &&
          typeof ctx.t[c.property.name] === 'function') {
        const args = []
        for (const a of node.arguments) {
          if (a.type === 'SpreadElement') return NOT_STATIC
          const v = staticValue(a, ctx, seen)
          if (v === NOT_STATIC) return NOT_STATIC
          args.push(v)
        }
        let v
        try { v = ctx.t[c.property.name](...args) } catch { return NOT_STATIC }
        ctx.tCalls.add(node)
        return v
      }
      return NOT_STATIC
    }
  }
  return NOT_STATIC
}

// Top level `const NAME = <expr>` and `import NAME from './x.json'`.
function constantsOf(ast, id) {
  const constants = new Map()
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
    if (decl && decl.type === 'VariableDeclaration' && decl.kind === 'const') {
      for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.init) constants.set(d.id.name, { init: d.init })
    }
    if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type' && /^\.{1,2}\/.*\.json$/.test(stmt.source.value)) {
      const def = stmt.specifiers.find((s) => s.type === 'ImportDefaultSpecifier')
      if (def) {
        const file = path.resolve(path.dirname(id), stmt.source.value)
        constants.set(def.local.name, { json: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return NOT_STATIC } } })
      }
    }
  }
  return constants
}

// `const name = new Validator(...)`, declared once, not exported, and used only
// as `name.<method>(...)` with a supported method.
function replaceableBinding(newExpr, ctx) {
  let decl = newExpr.__parent
  // `withKeywords(new Validator(schema))` from @ata-project/keywords: the
  // wrapper takes the keywords' check the way a Validator does, so the inner
  // call is replaced and withKeywords stays to register the check on it.
  if (decl && decl.type === 'CallExpression' && ctx.withKeywords && ctx.extendChecks &&
      decl.callee.type === 'Identifier' && decl.callee.name === ctx.withKeywords &&
      ctx.declared.get(ctx.withKeywords) === 1 && decl.arguments.length === 1 && decl.arguments[0] === newExpr) {
    decl = decl.__parent
    if (!decl || decl.type !== 'VariableDeclarator' || decl.init !== newExpr.__parent) return null
  }
  if (!decl || decl.type !== 'VariableDeclarator' || decl.id.type !== 'Identifier') return null
  if (decl.init !== newExpr && decl.init !== newExpr.__parent) return null
  const list = decl.__parent
  if (!list || list.type !== 'VariableDeclaration' || list.kind !== 'const') return null
  if (list.__parent && list.__parent.type === 'ExportNamedDeclaration') return null
  const name = decl.id.name
  if (ctx.declared.get(name) !== 1) return null
  const methods = new Set()
  for (const r of ctx.refs) {
    if (r.node.name !== name) continue
    const p = r.parent
    const member = p && (p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && r.key === 'object' && !p.computed && p.property.type === 'Identifier' && METHODS.has(p.property.name)
    const called = member && p.__parent && (p.__parent.type === 'CallExpression' || p.__parent.type === 'OptionalCallExpression') && p.__parent.callee === p
    if (!called) return null
    methods.add(p.property.name)
  }
  return { name, methods }
}

// Code that only asks for a boolean never reads an error.
const VERDICT_METHODS = new Set(['isValidObject', 'isValidJSON'])
const verdictOnly = (methods) => [...methods].every((m) => VERDICT_METHODS.has(m))

// A verdict-only module hands out isValid alone, so the error function inside
// it is unreferenced and the bundler drops it.
// A compact module takes its errors from this runtime, which a bundle holds
// once. A module is written compact only when it alone saves more than the
// runtime adds, so the choice never makes a bundle bigger, whatever else the
// bundle holds and in whatever order files are transformed. The bar is the
// module's gzipped saving as this transform sees it (unminified source), and
// it was set from minified esbuild bundles of one schema each: the runtime
// paid for itself from about 22000 bytes of that saving (a 300-property
// schema lost 1826 bytes at 19430, a 400-property one gained 1937 at 25127).
// Below it, a schema stays self-contained; `sharedErrors: true` writes every
// module compact, for an application with many schemas.
const ERROR_RUNTIME = 'ata-validator/error-runtime'
const ERROR_RUNTIME_COST = 24000
const RUNTIME_IMPORT = /^import \{ createErrors as _ataCreateErrors(?:, compileSafe as _ataCompileSafe)? \} from [^\n]*\n/m

// The scan and the transform weigh the same modules, and the module sources
// come back as the same strings from the session's compile cache: each is
// gzipped once per build (clearSizes runs at build start).
const sizes = new Map()
// The scan parses every source the transform parses again: once per build.
const asts = new Map()
function gzipSize(src) {
  let n = sizes.get(src)
  if (n === undefined) { n = zlib.gzipSync(src).length; if (sizes.size > 4096) sizes.clear(); sizes.set(src, n) }
  return n
}
export function clearSizes() { sizes.clear(); asts.clear() }

// The compact module when it is the choice for `mode`, else null:
//   true      wherever the schema allows it
//   'smaller' where it is smaller than the self-contained module (the build
//             scan found that the application as a whole pays for the runtime)
//   'auto'    where this module alone pays for the runtime
//   false     never
// With `collect`, nothing is chosen: the saving is recorded for the scan.
function compactModuleFor(schema, full, ata, mode, collect) {
  if (mode === false || !ata.compiledSharedErrors) return null
  let src = null
  try { src = ata.compiledModuleFor(schema, { format: 'esm', errorRuntime: ERROR_RUNTIME }) } catch { src = null }
  if (!src || !RUNTIME_IMPORT.test(src)) return null
  if (mode === true) return src
  // The scan collects the pairs and weighs them all at once, in parallel
  // (sharedErrorsPay); the transform finds the sizes cached.
  if (collect) { collect.push([full, src]); return null }
  const saving = gzipSize(full) - gzipSize(src)
  if (mode === 'smaller') return saving > 0 ? src : null
  return saving > ERROR_RUNTIME_COST ? src : null
}

// Whether an application pays for the shared runtime: the saving of every
// replaceable call in its sources, against the runtime's cost. `sources` is a
// list of [code, id]. A call the transform would not replace adds nothing.
// Gzipping a module of a hundred kilobytes is the scan's largest cost; the
// asynchronous zlib runs on libuv's thread pool, so the modules of a build
// are weighed in parallel rather than one after the other.
function gzipSizeAsync(src) {
  const n = sizes.get(src)
  if (n !== undefined) return Promise.resolve(n)
  return new Promise((resolve, reject) => zlib.gzip(src, (err, out) => {
    if (err) { reject(err); return }
    if (sizes.size > 4096) sizes.clear()
    sizes.set(src, out.length)
    resolve(out.length)
  }))
}

export async function sharedErrorsPay(sources, ata) {
  const collect = []
  for (const [code, id] of sources) {
    try { compileAway(code, id, ata, { sharedErrors: 'auto', collect }) } catch {}
  }
  const savings = await Promise.all(collect.map(async ([full, compact]) => (await gzipSizeAsync(full)) - (await gzipSizeAsync(compact))))
  let saving = 0
  for (const x of savings) if (x > 0) saving += x
  return { saving, pays: saving > ERROR_RUNTIME_COST, calls: collect.length }
}

function inlineModule(src, index, verdict, names) {
  const body = src.replace(RUNTIME_IMPORT, '').split('\n').filter((l) => !/^export\s/.test(l)).join('\n')
  return `const __ataCompiled${index} = (() => {\n${body}\nreturn ${names || (verdict ? '{ isValid }' : '{ validate, isValid }')};\n})();\n`
}

const RESOLVERS = '@hookform/resolvers/ata-validator'

// The resolver's options as source for ataCompiledResolver's second argument:
// '' for none, the literal's text for `{ raw: <boolean> }`, NOT_STATIC for
// anything else, which keeps the call on the runtime.
function resolverOptionsArg(args, code, ctx) {
  if (args.length === 1) return ''
  const isUndefined = (n) => n.type === 'Identifier' && n.name === 'undefined' && !ctx.declared.has('undefined')
  const schemaOptions = args[1]
  if (!isUndefined(schemaOptions)) {
    const v = staticValue(schemaOptions, ctx)
    if (v === NOT_STATIC || v === null || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 0) return NOT_STATIC
  }
  if (args.length === 2) return ''
  if (args.length !== 3 || isUndefined(args[2])) return args.length === 3 ? '' : NOT_STATIC
  const v = staticValue(args[2], ctx)
  if (v === NOT_STATIC || v === null || typeof v !== 'object' || Array.isArray(v)) return NOT_STATIC
  for (const [k, x] of Object.entries(v)) if (k !== 'raw' || typeof x !== 'boolean') return NOT_STATIC
  return ', ' + JSON.stringify(v)
}

// The options of `new Validator(schema, options)` as a third argument for
// fromCompiled(), or NOT_STATIC when the call has to stay on the runtime: options
// that are not a literal the build can read, or that name anything this
// ata-validator's wrapper does not reproduce. `useDefaults: true` is the default
// and needs no argument.
function compiledOptionsArg(node, ctx, supported) {
  const opts = staticValue(node, ctx)
  if (opts === NOT_STATIC || opts === null || typeof opts !== 'object' || Array.isArray(opts)) return NOT_STATIC
  for (const [key, value] of Object.entries(opts)) {
    if (!supported.includes(key)) return NOT_STATIC
    if (key === 'useDefaults' && typeof value !== 'boolean') return NOT_STATIC
  }
  return opts.useDefaults === false ? '{"useDefaults":false}' : ''
}

export function compileAway(code, id, ata, options) {
  const sharedErrors = options && options.sharedErrors !== undefined ? options.sharedErrors : 'auto'
  const collect = options && Array.isArray(options.collect) ? options.collect : null
  const { compiledModuleFor, compiledSchemaFor } = ata
  const supportedOptions = Array.isArray(ata.compiledOptions) ? ata.compiledOptions : []
  if (!code.includes('ata-validator')) return null
  // The scan keeps the tree it parsed for the transform, which takes it and
  // lets it go, so a long dev session holds no old versions of a file.
  let ast = asts.get(code)
  if (ast !== undefined) {
    if (!collect) asts.delete(code)
  } else {
    try {
      ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: false })
    } catch {
      ast = null
    }
    if (collect) asts.set(code, ast)
  }
  if (ast === null) return null
  let validatorName = null
  let importDecl = null
  let defineSchema = null
  let lastImportEnd = 0
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration') continue
    lastImportEnd = Math.max(lastImportEnd, stmt.end)
    if (stmt.source.value !== 'ata-validator' || stmt.importKind === 'type') continue
    for (const s of stmt.specifiers) {
      if (s.type !== 'ImportSpecifier' || s.importKind === 'type') continue
      const imported = s.imported.type === 'Identifier' ? s.imported.name : s.imported.value
      if (imported === 'Validator') { validatorName = s.local.name; importDecl = stmt }
      if (imported === 'defineSchema') defineSchema = s.local.name
    }
  }
  let resolverName = null
  let resolverImport = null
  if (ata.compiledResolver && ata.compiledResolver(id)) {
    for (const stmt of ast.program.body) {
      if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== RESOLVERS || stmt.importKind === 'type') continue
      for (const sp of stmt.specifiers) {
        if (sp.type !== 'ImportSpecifier' || sp.importKind === 'type') continue
        const imported = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value
        if (imported === 'ataResolver') { resolverName = sp.local.name; resolverImport = stmt }
      }
    }
  }
  if (!validatorName && !resolverName) return null
  let tName = null
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== 'ata-validator/t' || stmt.importKind === 'type') continue
    for (const sp of stmt.specifiers) {
      if (sp.type !== 'ImportSpecifier' || sp.importKind === 'type') continue
      const imported = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value
      if (imported === 't') tName = sp.local.name
    }
  }
  let withKeywords = null
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== '@ata-project/keywords' || stmt.importKind === 'type') continue
    for (const sp of stmt.specifiers) {
      if (sp.type !== 'ImportSpecifier' || sp.importKind === 'type') continue
      const imported = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value
      if (imported === 'withKeywords') withKeywords = sp.local.name
    }
  }

  const { declared, refs } = scan(ast)
  if (validatorName && declared.get(validatorName) !== 1) validatorName = null
  if (resolverName && declared.get(resolverName) !== 1) resolverName = null
  if (!validatorName && !resolverName) return null
  const ctx = { declared, refs, constants: constantsOf(ast, id), defineSchema, withKeywords, extendChecks: ata.compiledExtendChecks === true, t: ata.t || null, tName, tCalls: new Set() }

  const s = new MagicString(code)
  const modules = []
  const done = new Set()
  const wrappers = { full: false, verdict: false }
  let usesRuntime = false
  let usesSafeRe = false
  const resolverCalls = new Set()
  if (resolverName) {
    for (const r of refs) {
      if (r.node.name !== resolverName) continue
      const call = r.parent
      if (!call || call.type !== 'CallExpression' || r.key !== 'callee' || call.arguments.length < 1 || call.arguments.length > 3) continue
      if (call.arguments.some((a) => a.type === 'SpreadElement')) continue
      const extra = resolverOptionsArg(call.arguments, code, ctx)
      if (extra === NOT_STATIC) continue
      const schema = staticValue(call.arguments[0], ctx)
      if (schema === NOT_STATIC || schema === null || typeof schema !== 'object' || Array.isArray(schema)) continue
      let src = null
      try { src = compiledModuleFor(schema, { format: 'esm', order: true }) } catch { src = null }
      if (!src || !src.includes('function _ataOrder(')) continue
      const index = modules.length
      const fill = /\nfunction applyDefaults\(/.test(src)
      modules.push(inlineModule(src, index, false, fill ? '{ validate, applyDefaults }' : '{ validate }'))
      s.overwrite(call.start, call.end, `__ataCompiledResolver(__ataCompiled${index}${extra})`)
      resolverCalls.add(call)
      done.add(call)
    }
  }
  for (const r of refs) {
    if (!validatorName || r.node.name !== validatorName) continue
    const expr = r.parent
    if (!expr || expr.type !== 'NewExpression' || r.key !== 'callee') continue
    if (expr.arguments.length !== 1 && expr.arguments.length !== 2) continue
    let optionsArg = ''
    if (expr.arguments.length === 2) {
      optionsArg = compiledOptionsArg(expr.arguments[1], ctx, supportedOptions)
      if (optionsArg === NOT_STATIC) continue
    }
    const binding = replaceableBinding(expr, ctx)
    if (!binding) continue
    const schema = staticValue(expr.arguments[0], ctx)
    if (schema === NOT_STATIC || schema === null || typeof schema !== 'object' || Array.isArray(schema)) continue
    let src = null
    try { src = compiledModuleFor(schema, { format: 'esm' }) } catch { src = null }
    if (!src) continue
    const index = modules.length
    const verdict = ata.compiledVerdict === true && verdictOnly(binding.methods)
    // Code that never reads errors gets the verdict wrapper and no errors at
    // all, so a compact module would only add the runtime.
    const compact = verdict ? null : compactModuleFor(schema, src, ata, sharedErrors, collect)
    if (compact) { src = compact; usesRuntime = true; if (compact.includes('_ataCompileSafe')) usesSafeRe = true }
    modules.push(inlineModule(src, index, verdict))
    const wrap = verdict ? '__ataFromCompiledVerdict' : '__ataFromCompiled'
    if (verdict) wrappers.verdict = true; else wrappers.full = true
    s.overwrite(expr.start, expr.end, `${wrap}(__ataCompiled${index}, ${JSON.stringify(compiledSchemaFor(schema))}${optionsArg ? ', ' + optionsArg : ''})`)
    done.add(expr)
  }
  if (done.size === 0) return null

  // `Validator`, and `defineSchema` when it only wrapped a replaced schema,
  // leave the import once nothing else uses them, and the import goes when it
  // is left empty, so no bundler has to prove the runtime unused.
  const inReplaced = (node) => { for (const e of done) if (node.start >= e.start && node.end <= e.end) return true; return false }
  const prune = (decl, names) => {
    const unused = new Set()
    for (const spec of decl.specifiers) {
      if (spec.type !== 'ImportSpecifier') continue
      const name = spec.local.name
      if (!names.includes(name)) continue
      if (ctx.declared.get(name) !== 1) continue
      if (!refs.some((r) => r.node.name === name && !inReplaced(r.node))) unused.add(spec)
    }
    if (unused.size === decl.specifiers.length) s.remove(decl.start, decl.end)
    else if (unused.size) {
      const kept = decl.specifiers.filter((sp) => !unused.has(sp))
      const text = (sp) => code.slice(sp.start, sp.end)
      const def = kept.find((sp) => sp.type === 'ImportDefaultSpecifier')
      const named = kept.filter((sp) => sp.type === 'ImportSpecifier')
      const clause = [def ? text(def) : null, named.length ? `{ ${named.map(text).join(', ')} }` : null].filter(Boolean).join(', ')
      s.overwrite(decl.start, decl.end, `import ${clause} from ${code.slice(decl.source.start, decl.source.end)}`)
    }
  }
  if (importDecl) prune(importDecl, [validatorName, defineSchema].filter(Boolean))
  if (resolverImport && resolverCalls.size) prune(resolverImport, [resolverName])
  // The builder calls read here are pure, and marked so: a schema constant
  // only the replaced call used, and the builder with it, can then leave the
  // bundle.
  for (const call of ctx.tCalls) s.appendLeft(call.start, '/*#__PURE__*/ ')
  if (resolverCalls.size) s.prepend(`import { ataCompiledResolver as __ataCompiledResolver } from '${RESOLVERS}';\n`)
  if (wrappers.verdict) s.prepend(`import { fromCompiledVerdict as __ataFromCompiledVerdict } from 'ata-validator/compiled-verdict';\n`)
  if (wrappers.full) s.prepend(`import { fromCompiled as __ataFromCompiled } from 'ata-validator/compiled';\n`)
  // compileSafe is the pattern engine a compact module with a pattern the
  // platform RegExp does not run takes from the runtime instead of embedding.
  if (usesRuntime) s.prepend(`import { createErrors as _ataCreateErrors${usesSafeRe ? ', compileSafe as _ataCompileSafe' : ''} } from '${ERROR_RUNTIME}';\n`)
  s.appendLeft(lastImportEnd, '\n' + modules.join(''))
  return { code: s.toString(), map: s.generateMap({ hires: true, source: id, includeContent: true }), replaced: done.size }
}
