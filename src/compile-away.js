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
//     isValidObject(), validateJSON() or isValidJSON() on it, or hands it
//     over as a value (`body: check` in a route's options, `resolver(check)`),
//     where the wrapper carries Standard Schema (ata-validator 1.60.0) and
//     answers a consumer that reads `~standard` as the runtime does. Such a
//     consumer calling anything else on it gets a TypeError, not a wrong
//     answer; a use that reads a property of the instance keeps the runtime;
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
//
// `<Form schema={schema} validator={validator} />`, where `validator` is the
// default import of @rjsf/validator-ata and Form comes from an rjsf form
// package, gets a precompiled validator for that schema the same way, written
// by rjsf's own compileSchemaValidatorsCode from the installed copy:
//   - the element has no spread attributes, and `schema` is a value the build
//     can read, as above;
//   - the module is written in the runtime's error order and fills defaults
//     before the check, as rjsf's runtime validator does (core.js rjsfCompiler).
// rjsf's tests hold the precompiled validator to the runtime one.
//
// `schemaOf<T>()` from ata-validator, with `T` a named type, stands for the
// JSON Schema of that type, read with the TypeScript checker (`typeSchema` in
// the options, from core.js): the call is replaced by the schema as a literal,
// and `new Validator(schemaOf<T>())` then compiles like any static schema. A
// call the generator cannot answer (an inline type literal, a name it does
// not find, the generator not installed) is a build error: the function has
// no run-time form, so leaving the call in place would throw on load.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import { readsOnlyPlainFields, readsOnlyIssueFields, readsOnlyValid } from './error-use.js'
import { workspaceResolve, relativeResolve } from './workspace-resolve.js'
import { ZOD_RESOLVERS, zodRuntimeFor, ZOD_RUNTIME_IMPORTS, planZod, parseRefusal, selfCheck, zodFor, readZodFile, readModule, schemaSource, usesOf } from './zod-resolver.js'

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

// Whether every use of the constant `name` in its file leaves its value as
// written, so that the value read at build time is the one the runtime gets:
// an argument (the schema or the options) of `new Validator(...)` or
// `ataResolver(...)`, possibly through `defineSchema(...)`, the t builder and
// object or array literals, or the value of another top-level constant that
// passes the same test, or an export. Anything else, a
// write such as `schema.required = [...]`, a call that could change it, or a
// second name for it, keeps the call on the runtime: a schema changed after it
// was written was compiled as written and accepted what the runtime rejects.
function readOnly(name, ctx, seen = new Set()) {
  if (!ctx.refs) return false
  if (seen.has(name)) return true
  seen.add(name)
  for (const r of ctx.refs) {
    if (r.node.name !== name) continue
    if (!readOnlyUse(r, ctx, seen)) return false
  }
  return true
}

function readOnlyUse(r, ctx, seen) {
  if (r.parent && r.parent.type === 'ExportSpecifier') return true
  let node = r.node
  let up = r.parent
  for (;;) {
    if (!up) return false
    if (up.type === 'JSXExpressionContainer') {
      return ctx.rjsfSchemaAttrs !== undefined && ctx.rjsfSchemaAttrs.has(up)
    } else if (up.type === 'ObjectProperty') {
      if (up.value !== node) return false
    } else if (up.type === 'NewExpression' || up.type === 'CallExpression') {
      if (!up.arguments.includes(node)) return false
      const c = up.callee
      // `new Validator(...)` and `ataResolver(...)` take the value and end here.
      if (c.type === 'Identifier' && ctx.consumers && ctx.consumers.has(c.name)) return true
      // `defineSchema(...)` and the t builder hand it on: follow where the call goes.
      const passes = (c.type === 'Identifier' && c.name === ctx.defineSchema) ||
        (ctx.tName && c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === ctx.tName)
      if (!passes) return false
    } else if (up.type === 'VariableDeclarator') {
      if (up.init !== node || up.id.type !== 'Identifier') return false
      const list = up.__parent
      const top = list && list.type === 'VariableDeclaration' && list.kind === 'const' && list.__parent &&
        (list.__parent.type === 'Program' || list.__parent.type === 'ExportNamedDeclaration')
      return top ? readOnly(up.id.name, ctx, seen) : false
    } else if (up.type === 'ExportDefaultDeclaration') {
      return true
    } else if (!(up.type === 'ObjectExpression' || up.type === 'ArrayExpression' || up.type === 'TSAsExpression' ||
        up.type === 'TSSatisfiesExpression' || up.type === 'TSNonNullExpression' || up.type === 'ParenthesizedExpression')) {
      return false
    }
    node = up
    up = up.__parent
  }
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
      if (!source || !readOnly(node.name, ctx)) return NOT_STATIC
      seen.add(node.name)
      const v = source.json !== undefined ? source.json() : staticValue(source.init, ctx, seen)
      seen.delete(node.name)
      return v
    }
    case 'CallExpression': {
      if (node.callee.type === 'Identifier' && node.callee.name === ctx.defineSchema && node.arguments.length === 1) return staticValue(node.arguments[0], ctx, seen)
      if (ctx.typeSchemas && ctx.typeSchemas.has(node)) return ctx.typeSchemas.get(node)
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

// Top level `const NAME = <expr>`, `import NAME from './x.json'`, and names
// imported from a relative JavaScript or TypeScript module, read from that
// module's exports by the same rules (see moduleExport).
function constantsOf(ast, id, seen = new Set()) {
  const constants = new Map()
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
    if (decl && decl.type === 'VariableDeclaration' && decl.kind === 'const') {
      for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.init) constants.set(d.id.name, { init: d.init })
    }
    if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type' || !/^\.{1,2}\//.test(stmt.source.value)) continue
    if (/\.json$/.test(stmt.source.value)) {
      const def = stmt.specifiers.find((s) => s.type === 'ImportDefaultSpecifier')
      if (def) {
        const file = path.resolve(path.dirname(id), stmt.source.value)
        constants.set(def.local.name, { json: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return NOT_STATIC } } })
      }
      continue
    }
    for (const sp of stmt.specifiers) {
      if (sp.type === 'ImportNamespaceSpecifier' || sp.importKind === 'type') continue
      const name = sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value
      const source = stmt.source.value
      constants.set(sp.local.name, { json: () => moduleExport(resolveModule(id, source), name, seen) })
    }
  }
  return constants
}

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

// The file a relative import names, as TypeScript and the bundlers find it:
// as written, with an extension added, as a folder's index, or with `.js`
// standing for `.ts` (and `.mjs` for `.mts`).
function resolveModule(from, spec) {
  const base = path.resolve(path.dirname(from), spec)
  const candidates = [base, ...MODULE_EXTENSIONS.map((e) => base + e), ...MODULE_EXTENSIONS.map((e) => path.join(base, 'index' + e))]
  const swapped = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }[path.extname(base)]
  if (swapped) candidates.push(...swapped.map((e) => base.slice(0, -path.extname(base).length) + e))
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c } catch {}
  }
  return null
}

// The value module `file` exports as `name`, read without running it: an
// exported `const`, `export default <value>`, `export { local as name }`, or
// `export { x as name } from './other'`, followed through other modules up to
// a few levels. NOT_STATIC for anything else, or when a module is reached
// again on the way (a cycle).
function moduleExport(file, name, seen) {
  if (!file || seen.size > 8) return NOT_STATIC
  const key = file + '\0' + name
  if (seen.has(key)) return NOT_STATIC
  let ast
  try {
    ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: false })
  } catch {
    return NOT_STATIC
  }
  const next = new Set(seen).add(key)
  let defineSchema = null
  const consumers = new Set()
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== 'ata-validator' || stmt.importKind === 'type') continue
    for (const sp of stmt.specifiers) {
      if (sp.type !== 'ImportSpecifier') continue
      const imported = sp.imported.name || sp.imported.value
      if (imported === 'defineSchema') defineSchema = sp.local.name
      if (imported === 'Validator') consumers.add(sp.local.name)
    }
  }
  const { declared, refs } = scan(ast)
  const ctx = { declared, refs, consumers, constants: constantsOf(ast, file, next), defineSchema, t: null, tName: null, tCalls: new Set() }
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ExportDefaultDeclaration' && name === 'default') {
      return stmt.declaration.type.endsWith('Declaration') ? NOT_STATIC : staticValue(stmt.declaration, ctx)
    }
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.exportKind === 'type') continue
    if (stmt.declaration) {
      const d = stmt.declaration
      if (d.type === 'VariableDeclaration' && d.kind === 'const') {
        for (const v of d.declarations) {
          if (v.id.type === 'Identifier' && v.id.name === name && v.init) return readOnly(name, ctx) ? staticValue(v.init, ctx) : NOT_STATIC
        }
      }
      continue
    }
    for (const sp of stmt.specifiers) {
      if (sp.type !== 'ExportSpecifier' || sp.exportKind === 'type') continue
      const exported = sp.exported.type === 'Identifier' ? sp.exported.name : sp.exported.value
      if (exported !== name) continue
      const local = sp.local.type === 'Identifier' ? sp.local.name : sp.local.value
      if (stmt.source) return moduleExport(resolveModule(file, stmt.source.value), local, next)
      return staticValue({ type: 'Identifier', name: local }, ctx)
    }
  }
  return NOT_STATIC
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
  // Each validate() call, for src/error-use.js to follow its result.
  const validateCalls = []
  let handed = false
  // Handed only to Standard Schema consumers the build knows (ctx.standardConsumers).
  let handedStandard = false
  for (const r of ctx.refs) {
    if (r.node.name !== name) continue
    if (r.node === decl.id) continue
    const p = r.parent
    const member = p && (p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && r.key === 'object' && !p.computed && p.property.type === 'Identifier' && METHODS.has(p.property.name)
    const called = member && p.__parent && (p.__parent.type === 'CallExpression' || p.__parent.type === 'OptionalCallExpression') && p.__parent.callee === p
    if (called) { methods.add(p.property.name); if (p.property.name === 'validate') validateCalls.push(p.__parent); continue }
    if (ctx.compiledStandard) {
      const call = handedTo(r)
      if (call !== null) {
        if (isStandardConsumer(call.callee, ctx)) handedStandard = true
        else handed = true
        continue
      }
    }
    return null
  }
  // Through withKeywords the wrapper is handed over too: the keywords register
  // their check on it with _extendChecks, which only the full wrappers have.
  if (decl.init !== newExpr) handed = true
  // A validator handed over needs the full wrapper: the consumer reads
  // `~standard`, which gives errors. One handed only to known Standard Schema
  // consumers, and never called by its own code, can take the wrapper that
  // carries `~standard` alone (ata.compiledStandardWrapper); otherwise a handover to
  // such a consumer counts like any other.
  const standardOnly = handedStandard && !handed && methods.size === 0 && ctx.standardWrapper === true
  if (handed || (handedStandard && !standardOnly)) { handed = true; methods.add('validate') }
  return { name, methods, handed, standardOnly, validateCalls }
}

// Whether a callee belongs to a package that takes a Standard Schema and reads
// only its `~standard`: the call chain's root is a binding imported from such
// a package. The root is found through members, calls and constructions, and
// through top-level constants of the file: `sValidator`, `sv.sValidator`,
// `new Elysia().post`, `app.post` with `const app = new Elysia()`,
// `publicProcedure.input` with `const t = initTRPC.create()` and
// `const publicProcedure = t.procedure`.
function isStandardConsumer (callee, ctx) {
  const c = ctx.standardConsumers
  if (!c || c.size === 0) return false
  const root = (node, depth) => {
    if (!node || depth > 24) return false
    switch (node.type) {
      case 'Identifier': {
        if (ctx.declared.get(node.name) !== 1) return false
        if (c.has(node.name)) return true
        const k = ctx.constants.get(node.name)
        return !!(k && k.init) && root(k.init, depth + 1)
      }
      case 'MemberExpression': case 'OptionalMemberExpression': return root(node.object, depth + 1)
      case 'CallExpression': case 'OptionalCallExpression': case 'NewExpression': return root(node.callee, depth + 1)
      case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'ParenthesizedExpression': return root(node.expression, depth + 1)
      case 'AwaitExpression': return root(node.argument, depth + 1)
      default: return false
    }
  }
  return root(callee, 0)
}

// Packages whose functions take a Standard Schema and read nothing of it but
// `~standard`: a router's validator middleware (`sValidator('json', v)`,
// `validator('json', v)`), a form library (`useForm({ validators: { onChange:
// v } })`), an RPC layer (`os.input(v)`, `publicProcedure.input(v)`) and
// Elysia's hooks (`app.post(path, handler, { body: v })`). A package goes on
// the list only when every function of it that takes a schema reads
// `~standard` alone. `standardConsumers` in the plugin options adds packages.
const STANDARD_CONSUMERS = [
  '@hono/standard-validator', 'hono-openapi',
  '@tanstack/form-core', '@tanstack/react-form', '@tanstack/vue-form', '@tanstack/solid-form', '@tanstack/angular-form',
  '@orpc/server', '@orpc/contract',
  '@trpc/server',
  'elysia',
]

// Whether a use of the validator hands it to something else as a value: an
// argument of a call, directly or inside object and array literals (`{ body:
// v }`, `[v]`), through TypeScript wrappers and parentheses. The call itself
// is not read (it may be any function); only the shape of the use is. A
// member read, an assignment, an export or a return keeps the runtime.
function handedOver (r) { return handedTo(r) !== null }
// The call or construction a use hands the validator to, or null.
function handedTo (r) {
  let node = r.node
  let up = r.parent
  for (;;) {
    if (!up) return null
    if (up.type === 'CallExpression' || up.type === 'OptionalCallExpression' || up.type === 'NewExpression') {
      return up.arguments.includes(node) ? up : null
    }
    if (up.type === 'ObjectProperty') { if (up.value !== node) return null }
    else if (!(up.type === 'ObjectExpression' || up.type === 'ArrayExpression' || up.type === 'TSAsExpression' || up.type === 'TSSatisfiesExpression' || up.type === 'TSNonNullExpression' || up.type === 'ParenthesizedExpression')) return null
    node = up
    up = up.__parent
  }
}

// Code that only asks for a boolean never reads an error.
const VERDICT_METHODS = new Set(['isValidObject', 'isValidJSON'])
const verdictOnly = (methods) => [...methods].every((m) => VERDICT_METHODS.has(m))
// Code that never validates JSON text: validate(), isValidObject() and a
// Standard Schema handover all go through the object wrapper.
const JSON_METHODS = new Set(['validateJSON', 'isValidJSON'])
const noJson = (methods) => ![...methods].some((m) => JSON_METHODS.has(m))

// A verdict-only module hands out isValid alone, so the error function inside
// it is unreferenced and the bundler drops it.
// A compact module takes its errors from this runtime, which a bundle holds
// once. A module is written compact only when it alone saves more than the
// runtime adds, so the choice never makes a bundle bigger, whatever else the
// bundle holds and in whatever order files are transformed. The bar is the
// module's gzipped saving as this transform sees it (unminified source), set
// from minified esbuild bundles of one schema each, for a browser and for a
// Node target, of two kinds of schema: fields described at length, and bare
// fields. Where the runtime starts to pay differs by kind and target: between
// 37481 and 42436 for described fields in a browser, between 56147 and 74091
// for bare ones in Node, which carries the IDNA tables the browser build
// leaves out. The bar is above every loss measured. It was 24000, set when the runtime was smaller; by ata-validator
// 1.63.1 that wrote compact modules 4 to 7 KB larger than the self-contained
// ones for schemas between the two figures. test/shared-errors-cost.test.js
// holds the bar to real bundles. Below it, a schema stays self-contained;
// `sharedErrors: true` writes every module compact, for an application with
// many schemas.
const ERROR_RUNTIME = 'ata-validator/error-runtime'
const ERROR_RUNTIME_COST = 65000
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

// What each scanned file saves by taking its errors from the shared runtime:
// a Map of file -> { saving, calls }, the files with no replaceable call left
// out.
export async function sharedSavings(sources, ata, errorFields) {
  const out = new Map()
  for (const [code, id] of sources) {
    const collect = []
    try { compileAway(code, id, ata, { sharedErrors: 'auto', collect, errorFields }) } catch {}
    if (!collect.length) continue
    const savings = await Promise.all(collect.map(async ([full, compact]) => (await gzipSizeAsync(full)) - (await gzipSizeAsync(compact))))
    let saving = 0
    for (const x of savings) if (x > 0) saving += x
    out.set(id, { saving, calls: collect.length })
  }
  return out
}
// Whether files that load together pay for the runtime: `files` names the
// ones to count, all of them when left out.
export function sharedPays(savings, files) {
  let saving = 0; let calls = 0
  for (const id of files || savings.keys()) { const r = savings.get(id); if (r) { saving += r.saving; calls += r.calls } }
  return { saving, pays: saving > ERROR_RUNTIME_COST, calls }
}
export async function sharedErrorsPay(sources, ata) {
  return sharedPays(await sharedSavings(sources, ata))
}

// Whether the application's IR validators are smaller as table plans: every
// scanned file rewritten both ways, as the transform would rewrite it, and
// the two outputs compared gzipped, all files together, against
// TABLE_RUNTIME_COST, what the table interpreter costs a bundle over the
// helpers written modules use. The plugin asks this of the files one page
// loads together (src/first-load.js), not of the project. Set from Vite + React builds of 1 to 10 form
// validators, plain and rich, with and without format checks, 24 in all: the
// saving computed here was at most 1694 bytes wherever plans made the larger
// first load (every single-form build) and at least 2182 wherever they made
// the smaller one (two forms on), so a choice of plans is never the larger
// bundle on those.
export const TABLE_RUNTIME_COST = 1900
// Each scanned file the table changes, rewritten both ways: a Map of file ->
// { modules, plans, calls }.
export function tableForms(sources, ata, errorFields, smallFormats = false) {
  const out = new Map()
  for (const [code, id] of sources) {
    let m = null; let t = null
    try { m = compileAway(code, id, ata, { sharedErrors: false, ir: true, table: false, errorFields, smallFormats }) } catch {}
    try { t = compileAway(code, id, ata, { sharedErrors: false, ir: true, table: true, errorFields }) } catch {}
    if (!m || !t || m.code === t.code) continue
    out.set(id, { modules: m.code, plans: t.code, calls: (t.code.match(/__ataK_table(?:Plain|Rich)\(/g) || []).length })
  }
  return out
}
// Whether files that load together are smaller as plans: `files` names the
// ones to count, all of them when left out.
export async function tableFormsPay(forms, files, cost = TABLE_RUNTIME_COST) {
  const modules = []; const plans = []; let calls = 0
  for (const id of files || forms.keys()) { const f = forms.get(id); if (f) { modules.push(f.modules); plans.push(f.plans); calls += f.calls } }
  if (calls === 0) return { pays: false, saving: 0, calls: 0 }
  const saving = (await gzipSizeAsync(modules.join('\n'))) - (await gzipSizeAsync(plans.join('\n')))
  return { pays: saving > cost, saving, calls }
}
export async function tablePays(sources, ata, cost = TABLE_RUNTIME_COST) {
  return tableFormsPay(tableForms(sources, ata), null, cost)
}

// The module's version stamp and, when its schema has a default, its own
// defaults pass go out with it: the wrappers fill defaults with that pass and
// read the stamp to know they can (lib/compiled-common.js in ata-validator),
// so the defaults engine stays out of the bundle.
const DEFAULTS_EXPORT = /^export \{[^}]*\bapplyDefaults\b/m
const VERSION_EXPORT = /^export \{[^}]*\bataVersion\b/m
function inlineModule(src, index, verdict, names) {
  const body = src.replace(RUNTIME_IMPORT, '').split('\n').filter((l) => !/^export\s/.test(l)).join('\n')
  // A caller that names its own exports (a form resolver) gets those only.
  const base = verdict ? '{ isValid }' : '{ validate, isValid }'
  const add = [DEFAULTS_EXPORT.test(src) && 'applyDefaults', VERSION_EXPORT.test(src) && 'ataVersion'].filter(Boolean)
  const out = names || (add.length ? base.replace(/\s*\}$/, ', ' + add.join(', ') + ' }') : base)
  return `const __ataCompiled${index} = (() => {\n${pruneModule(body, out.replace(/[{}\s]/g, '').split(','))}\nreturn ${out};\n})();\n`
}

// The module's top-level declarations that nothing returned reaches, cut
// before it is inlined. Inside the function that holds an inlined module a
// bundler removes nothing, so the schema hash, a helper the schema never
// called, or a verdict-only module's validate() all shipped. A declaration is
// cut only when its value has no side effect to lose (a function, a literal,
// an Object.freeze of those, a property read off a global); anything else
// stays, and so does everything it names. A name shadowed in an inner scope
// counts as a use, which can only keep more.
const PURE_CALLS = new Set(['Object.freeze', 'Object.create', 'Object.getPrototypeOf'])
const PURE_NEW = new Set(['RegExp', 'Set', 'Map'])
function pruneModule(body, keep) {
  let ast
  try { ast = parse(body, { sourceType: 'script', errorRecovery: false }) } catch { return body }
  const calleeName = (c) => c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.property.type === 'Identifier' ? `${c.object.name}.${c.property.name}` : null
  const pure = (n) => {
    if (!n) return true
    switch (n.type) {
      case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': case 'NullLiteral': case 'RegExpLiteral': case 'BigIntLiteral':
      case 'Identifier': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ThisExpression':
        return true
      case 'TemplateLiteral': return n.expressions.every(pure)
      case 'MemberExpression': return pure(n.object) && (!n.computed || pure(n.property))
      case 'ObjectExpression': return n.properties.every((p) => p.type === 'ObjectProperty' && (!p.computed || pure(p.key)) && pure(p.value))
      case 'ArrayExpression': return n.elements.every((e) => e === null || pure(e))
      case 'UnaryExpression': return n.operator !== 'delete' && pure(n.argument)
      case 'BinaryExpression': case 'LogicalExpression': return pure(n.left) && pure(n.right)
      case 'ConditionalExpression': return pure(n.test) && pure(n.consequent) && pure(n.alternate)
      case 'ParenthesizedExpression': return pure(n.expression)
      case 'CallExpression': return PURE_CALLS.has(calleeName(n.callee)) && n.arguments.every(pure)
      case 'NewExpression': return n.callee.type === 'Identifier' && PURE_NEW.has(n.callee.name) && n.arguments.every(pure)
      default: return false
    }
  }
  // Every identifier a node reads, skipping property names and object keys.
  const reads = (node, out) => {
    const walk = (n, parent, key) => {
      if (!n || typeof n.type !== 'string') return
      if (n.type === 'Identifier') {
        if (parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) return
        if (parent && (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') && key === 'key' && !parent.computed) return
        out.add(n.name)
        return
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue
        const v = n[k]
        if (Array.isArray(v)) for (const x of v) walk(x, n, k)
        else if (v && typeof v === 'object') walk(v, n, k)
      }
    }
    walk(node, null, null)
    return out
  }
  const stmts = ast.program.body.map((st) => {
    let name = null
    let removable = false
    if (st.type === 'FunctionDeclaration' && st.id) { name = st.id.name; removable = true }
    else if (st.type === 'VariableDeclaration' && st.declarations.length === 1 && st.declarations[0].id.type === 'Identifier') {
      name = st.declarations[0].id.name; removable = pure(st.declarations[0].init)
    }
    const r = reads(st, new Set())
    if (name) r.delete(name)
    return { st, name, removable, reads: r }
  })
  const byName = new Map()
  for (const x of stmts) if (x.name) byName.set(x.name, x)
  const alive = new Set()
  const work = []
  const mark = (x) => { if (!alive.has(x)) { alive.add(x); work.push(x) } }
  for (const x of stmts) if (!x.removable) mark(x)
  for (const k of keep) { const x = byName.get(k); if (x) mark(x) }
  while (work.length) for (const n of work.pop().reads) { const x = byName.get(n); if (x) mark(x) }
  if (alive.size === stmts.length) return body
  let outText = ''
  let at = 0
  for (const x of stmts) {
    if (alive.has(x)) continue
    outText += body.slice(at, x.st.start)
    at = x.st.end
  }
  return outText + body.slice(at)
}

const RESOLVERS = '@hookform/resolvers/ata-validator'
// rjsf's form packages: core and the themes.
const RJSF_FORMS = /^@rjsf\/(core|mui|antd|chakra-ui|fluentui-rc|semantic-ui|daisyui|shadcn|primereact|react-bootstrap|mantine)$/

// The compiled resolver, written into a file whose @hookform/resolvers has
// none. It is ataResolver of @hookform/resolvers/ata-validator with the
// Validator taken out: the same field errors from the same error list (the
// first error of a field, every one under criteriaMode 'all', a missing
// property reported at the property), through the resolvers' own
// toNestErrors, and defaults filled first as the Validator fills them.
const OWN_RESOLVER = `import { toNestErrors as __ataNest, validateFieldsNatively as __ataNative } from '@hookform/resolvers';
import { appendErrors as __ataAppend } from 'react-hook-form';
const __ataFieldErrors = (errs, all) => { const out = Object.create(null); for (let i = 0; i < errs.length; i += 1) { const e = errs[i]; const p = (e.keyword === 'required' ? e.instancePath + '/' + e.params.missingProperty : e.instancePath).substring(1).replace(/\\//g, '.'); if (!out[p]) out[p] = { message: e.message, type: e.keyword }; if (all) { const t = out[p].types; const m = t && t[e.keyword]; out[p] = __ataAppend(p, all, out, e.keyword, m ? [].concat(m, e.message || '') : e.message) } } return out };
const __ataCompiledResolver = (c, ro = {}) => async (values, _, o) => { if (c.applyDefaults) c.applyDefaults(values); const r = c.validate(values); o.shouldUseNativeValidation && __ataNative({}, o); return r.valid ? { values: ro.raw ? Object.assign({}, values) : values, errors: {} } : { values: {}, errors: __ataNest(__ataFieldErrors(r.errors, !o.shouldUseNativeValidation && o.criteriaMode === 'all'), o) } };
`

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
// `plain` (ata-validator 1.61.1 on, `ata.compiledPlain`): `richErrors: false`
// is read too, and the call is marked for the plain wrapper.
function compiledOptionsArg(node, ctx, supported, plainOk, out) {
  const opts = staticValue(node, ctx)
  if (opts === NOT_STATIC || opts === null || typeof opts !== 'object' || Array.isArray(opts)) return NOT_STATIC
  for (const [key, value] of Object.entries(opts)) {
    if (key === 'richErrors' && plainOk && value === false) { out.plain = true; continue }
    if (!supported.includes(key)) return NOT_STATIC
    if (key === 'useDefaults' && typeof value !== 'boolean') return NOT_STATIC
  }
  const parts = []
  if (out.plain) parts.push('"richErrors":false')
  if (opts.useDefaults === false) parts.push('"useDefaults":false')
  return parts.length ? `{${parts.join(',')}}` : ''
}

// Whether the options literal says `richErrors` itself: then it is the
// author's choice, not the build's.
function namesRichErrors(node, ctx) {
  if (!node) return false
  const opts = staticValue(node, ctx)
  return opts === NOT_STATIC || opts === null || typeof opts !== 'object' || Object.prototype.hasOwnProperty.call(opts, 'richErrors')
}

export function compileAway(code, id, ata, options) {
  const errorFields = options && options.errorFields === 'all' ? 'all' : 'auto'
  const sharedErrors = options && options.sharedErrors !== undefined ? options.sharedErrors : 'auto'
  const collect = options && Array.isArray(options.collect) ? options.collect : null
  // `table`: write IR validators as plans for ata-validator/kernels' table
  // interpreter (lib/ir/table.mjs) where one exists; decided for the whole
  // application by tablePays below.
  const table = options && options.table === true
  // A written module names the smaller check of a format where ata-validator
  // has one (specialize's smallFormats, from 1.64.0; an older one ignores it).
  const smallFormats = !!(options && options.smallFormats === true)
  const typeSchema = options && typeof options.typeSchema === 'function' ? options.typeSchema : null
  // Under Bun's ahead-of-time compile a TypeScript file is type-checked with
  // the project's strictness, and a compiled module written into it as plain
  // JavaScript fails that check (TS7006 on its first untyped parameter). There
  // the module becomes a virtual `.js` module of its own, which the checker
  // does not read: `options.virtual(src)` registers the source and returns the
  // specifier to import it from.
  const virtual = options && typeof options.virtual === 'function' ? options.virtual : null
  const virtualImports = []
  const placeModule = (name, src, verdict, names) => {
    // The checker has no declaration for a virtual module (TS2307 under a
    // strict project); the one line is excused and the module is `any`, as
    // the inlined JavaScript was. The file's own code stays checked.
    if (virtual) virtualImports.push(`// @ts-ignore: a module @ata-project/unplugin wrote at build time\nimport * as ${name} from ${JSON.stringify(virtual(src))};\n`)
    else modules.push(inlineModule(src, name.replace(/^__ataCompiled/, ''), verdict, names))
  }
  const { compiledModuleFor, compiledSchemaFor } = ata
  const supportedOptions = Array.isArray(ata.compiledOptions) ? ata.compiledOptions : []
  const mayParse = !!(options && options.zodSafeParse === true) && code.includes('.safeParse(')
  if (!code.includes('ata-validator') && !code.includes('@rjsf/validator-ata') && !code.includes(ZOD_RESOLVERS) && !mayParse) return null
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
  let schemaOfName = null
  // Where the imports a rewrite adds go: the top of the file, or after its
  // directives ('use client', 'use server', 'use strict'), which are
  // directives only while nothing stands before them.
  const directives = ast.program.directives || []
  const head = directives.length ? directives[directives.length - 1].end : 0
  let lastImportEnd = head
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration') continue
    lastImportEnd = Math.max(lastImportEnd, stmt.end)
    if (stmt.source.value !== 'ata-validator' || stmt.importKind === 'type') continue
    for (const s of stmt.specifiers) {
      if (s.type !== 'ImportSpecifier' || s.importKind === 'type') continue
      const imported = s.imported.type === 'Identifier' ? s.imported.name : s.imported.value
      if (imported === 'Validator') { validatorName = s.local.name; importDecl = stmt }
      if (imported === 'defineSchema') defineSchema = s.local.name
      if (imported === 'schemaOf') { schemaOfName = s.local.name; if (!importDecl) importDecl = stmt }
    }
  }
  let resolverName = null
  let resolverImport = null
  const resolverKind = ata.compiledResolver ? ata.compiledResolver(id) : false
  if (resolverKind) {
    for (const stmt of ast.program.body) {
      if (stmt.type !== 'ImportDeclaration' || stmt.source.value !== RESOLVERS || stmt.importKind === 'type') continue
      for (const sp of stmt.specifiers) {
        if (sp.type !== 'ImportSpecifier' || sp.importKind === 'type') continue
        const imported = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value
        if (imported === 'ataResolver') { resolverName = sp.local.name; resolverImport = stmt }
      }
    }
  }
  // rjsf: the default import of @rjsf/validator-ata, and the form components
  // of rjsf's packages (the default export, or `Form` by name).
  let rjsfName = null
  let rjsfImport = null
  const formNames = new Set()
  const rjsfCompile = ata.rjsfCompiler ? ata.rjsfCompiler(id) : null
  if (rjsfCompile) {
    for (const stmt of ast.program.body) {
      if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue
      const from = stmt.source.value
      if (from === '@rjsf/validator-ata') {
        for (const sp of stmt.specifiers) if (sp.type === 'ImportDefaultSpecifier') { rjsfName = sp.local.name; rjsfImport = stmt }
      } else if (RJSF_FORMS.test(from)) {
        for (const sp of stmt.specifiers) {
          if (sp.type === 'ImportDefaultSpecifier') formNames.add(sp.local.name)
          else if (sp.type === 'ImportSpecifier' && sp.importKind !== 'type' && (sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value) === 'Form') formNames.add(sp.local.name)
        }
      }
    }
    if (formNames.size === 0) rjsfName = null
  }
  // zodResolver(schema) with zod under one name: read where the IR writes the
  // check and the file resolves what the written resolver imports.
  const zodOn = !!(options && options.ir && ata.ir && ata.Validator)
  const wantResolver = zodOn && options.zodResolver !== false && !!ata.zodResolverReady && ata.zodResolverReady(id)
  // schema.safeParse(value) on a zod schema the file can read: no resolver
  // and nothing of react-hook-form is needed for it.
  const wantParse = zodOn && mayParse
  let zodFile = wantResolver || wantParse ? readZodFile(ast, false) : null
  if (zodFile && !(wantResolver && zodFile.resolver) && !wantParse) zodFile = null
  if (!validatorName && !resolverName && !rjsfName && !schemaOfName && !zodFile) return null
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

  // Local names imported from Standard Schema consumers (see STANDARD_CONSUMERS).
  const consumerSources = new Set(STANDARD_CONSUMERS.concat(Array.isArray(options && options.standardConsumers) ? options.standardConsumers : []))
  const standardConsumers = new Set()
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type' || !consumerSources.has(stmt.source.value)) continue
    for (const sp of stmt.specifiers) if (sp.importKind !== 'type') standardConsumers.add(sp.local.name)
  }

  const { declared, refs } = scan(ast)
  if (validatorName && declared.get(validatorName) !== 1) validatorName = null
  if (resolverName && declared.get(resolverName) !== 1) resolverName = null
  if (rjsfName && declared.get(rjsfName) !== 1) rjsfName = null
  if (schemaOfName && declared.get(schemaOfName) !== 1) schemaOfName = null
  // Every schemaOf<T>() call gets its schema now, or the build stops.
  const typeSchemas = new Map()
  if (schemaOfName) {
    for (const r of refs) {
      if (r.node.name !== schemaOfName) continue
      const call = r.parent
      const where = `${id}:${r.node.loc ? r.node.loc.start.line : '?'}`
      if (!call || call.type !== 'CallExpression' || r.key !== 'callee') throw new Error(`${where}: schemaOf is only replaced as a call, schemaOf<T>()`)
      const tp = call.typeParameters || call.typeArguments
      if (!tp || tp.params.length !== 1 || call.arguments.length !== 0) throw new Error(`${where}: schemaOf takes one type argument and no value: schemaOf<User>()`)
      const t = tp.params[0]
      if (t.type !== 'TSTypeReference' || t.typeName.type !== 'Identifier' || t.typeParameters) throw new Error(`${where}: schemaOf<T>() needs a named type (interface or type alias); name the type and pass its name`)
      if (!typeSchema) throw new Error(`${where}: schemaOf<${t.typeName.name}>() needs ts-json-schema-generator and typescript installed beside @ata-project/unplugin`)
      typeSchemas.set(call, typeSchema(id, t.typeName.name))
    }
  }
  if (!validatorName && !resolverName && !rjsfName && typeSchemas.size === 0 && !zodFile) return null
  const consumers = new Set([validatorName, resolverName].filter(Boolean))
  // The rjsf forms that can take a precompiled validator: `validator={<the
  // import>}` and `schema={...}` on an rjsf form element without spread
  // attributes. Their schema attributes count as reading the schema: rjsf does
  // not change the schema it is given.
  const forms = []
  const rjsfSchemaAttrs = new Set()
  if (rjsfName) {
    for (const r of refs) {
      if (r.node.name !== rjsfName) continue
      const container = r.parent
      const attr = container && container.type === 'JSXExpressionContainer' ? container.__parent : null
      if (!attr || attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier' || attr.name.name !== 'validator') continue
      const el = attr.__parent
      if (!el || el.type !== 'JSXOpeningElement' || el.name.type !== 'JSXIdentifier' || !formNames.has(el.name.name) || declared.get(el.name.name) !== 1) continue
      if (el.attributes.some((a) => a.type === 'JSXSpreadAttribute')) continue
      const schemaAttrs = el.attributes.filter((a) => a.name.type === 'JSXIdentifier' && a.name.name === 'schema')
      if (schemaAttrs.length !== 1 || !schemaAttrs[0].value || schemaAttrs[0].value.type !== 'JSXExpressionContainer') continue
      const schemaAttr = schemaAttrs[0].value
      if (schemaAttr.expression.type === 'JSXEmptyExpression') continue
      forms.push({ container, schemaAttr })
      rjsfSchemaAttrs.add(schemaAttr)
    }
  }
  const ctx = { declared, refs, consumers, rjsfSchemaAttrs, typeSchemas, constants: constantsOf(ast, id), defineSchema, withKeywords, extendChecks: ata.compiledExtendChecks === true, standardConsumers, standardWrapper: ata.compiledStandardWrapper === true, compiledStandard: ata.compiledStandard === true, t: ata.t || null, tName, tCalls: new Set() }

  const s = new MagicString(code)

  const addImport = (text) => { if (head === 0) s.prepend(text); else s.appendLeft(head, '\n' + text.replace(/\n$/, '')) }
  const modules = []
  const done = new Set()
  const wrappers = { full: false, verdict: false, object: false, plain: false, bare: false, bareRich: false, standard: false }
  // How many calls took each wrapper, for the build report.
  const kinds = { standard: 0, verdict: 0, plain: 0, errors: 0 }
  let usesRuntime = false
  let usesSafeRe = false
  // Under the `ir` option: the helpers of ata-validator/kernels the file's IR
  // modules use, imported once under aliases.
  const irKernels = new Set()
  // `validOnly`: validate() is called, and every result is read through
  // `valid` alone. The module is written without its error functions, as for
  // isValidObject, and validate() answers with the verdict in an object.
  // Both run the defaults pass and the same verdict function, so the answer
  // and what is written onto the document are what validate() gave.
  const placeIR = (index, src, verdictOnly, validOnly) => {
    const m = /^import \{([^}]*)\} from "ata-validator\/kernels"\n/.exec(src)
    const body = pruneModule((m ? src.slice(m[0].length) : src).replace(/^export function /gm, 'function '), verdictOnly ? ['isValid'] : ['validate', 'isValid'])
    // The helpers the pruned body still names (a verdict module drops the
    // error constructor with the error procedures).
    const names = (m ? m[1].split(',').filter(Boolean) : []).filter((n) => new RegExp(`(?<![\\w$.])${n}(?![\\w$])`).test(body))
    for (const n of names) irKernels.add(n)
    const alias = names.length ? `const ${names.map((n) => `${n} = __ataK_${n}`).join(', ')};\n` : ''
    modules.push(`const __ataCompiled${index} = (() => {\n${alias}${body}\nreturn ${validOnly ? '{ validate: (d) => ({ valid: isValid(d) }), isValidObject: isValid }' : verdictOnly ? '{ isValidObject: isValid }' : '{ validate, isValidObject: isValid }'};\n})();\n`)
  }
  // A table plan: data and the kernels it names, each read as the import the
  // file gets (__ataK_), outside string literals; no aliases to repeat per
  // validator.
  const placeTable = (index, src, verdictOnly) => {
    const m = /^import \{([^}]*)\} from "ata-validator\/kernels"\n/.exec(src)
    const names = new Set(m ? m[1].split(',').filter(Boolean) : [])
    let body = (m ? src.slice(m[0].length) : src).replace(/^export const\{isValid,validate\}=/m, 'const{isValid,validate}=')
    body = body.replace(/"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*/g, (t) => t[0] !== '"' && names.has(t) ? (irKernels.add(t), '__ataK_' + t) : t)
    // A plan and nothing else: the interpreter's object is the validator
    // (it answers isValidObject too), with no function around it.
    const bare = /^const P=(\[[^\n]*\])\nconst\{isValid,validate\}=(__ataK_table(?:Plain|Rich))\(P((?:,[^\n]*)?)\)\n?$/.exec(body)
    if (bare) { modules.push(`const __ataCompiled${index} = ${bare[2]}(${bare[1]}${bare[3]});\n`); return }
    modules.push(`const __ataCompiled${index} = (() => {\n${body}\nreturn ${verdictOnly ? '{ isValidObject: isValid }' : '{ validate, isValidObject: isValid }'};\n})();\n`)
  }
  // The IR's form of a validator: a table plan where the application chose
  // them and the schema is one the table takes, the module otherwise.
  // `verify` holds what ata-validator/ir writes for a schema against the
  // runtime: the written module under the Validator's default options, with
  // its errors, whichever of the IR's forms the build takes (a module with
  // other options, a verdict alone, a plan). They are written from the same
  // reading of the schema, so a reference the IR cannot follow or a keyword
  // it reads another way shows in this one. Before this the list was filled
  // on the standalone path only, and a build on the IR, the default from
  // ata-validator 1.63.1, verified nothing.
  const holdIR = (schema, at) => {
    if (!(options && options.verifying instanceof Map) || !ata.kernelsUrl) return
    let full = null
    try { full = ata.ir.specialize(schema, { verdict: true, fillSource: ata.defaultsSource || undefined }) } catch { full = null }
    if (!full) return
    // Two validators written on one line keep an entry each.
    const base = `${id}:${at && at.loc ? at.loc.start.line : '?'}`
    let key = base
    for (let n = 2; options.verifying.has(key); n++) key = `${base}#${n}`
    options.verifying.set(key, { schema, src: full.replace(/(['"])ata-validator\/kernels\1/g, () => JSON.stringify(ata.kernelsUrl)) })
  }
  const irFor = (schema, opts, verdictOnly, at) => {
    let irSrc = null
    try { irSrc = ata.ir.specialize(schema, { ...opts, verdict: true, fillSource: ata.defaultsSource || undefined, smallFormats }) } catch { irSrc = null }
    if (!irSrc) return null
    holdIR(schema, at)
    if (table && typeof ata.ir.tableModule === 'function') {
      let tab = null
      try { tab = ata.ir.tableModule(schema, opts) } catch { tab = null }
      if (tab) return { src: tab, place: placeTable }
    }
    return { src: irSrc, place: (i, x, v, only) => placeIR(i, x, v, only) }
  }
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
      // With ata-validator/ir (the `ir` option): a module with plain errors. A
      // resolver reads keyword, instancePath, params and message of each
      // error, in order, and those are the same in the plain shape, which
      // leaves the error enrichment out of the bundle.
      if (options && options.ir && ata.ir && !virtual) {
        const ir = irFor(schema, { richErrors: false }, false, call)
        if (ir) {
          const index = modules.length
          ir.place(index, ir.src, false)
          s.overwrite(call.start, call.end, `__ataCompiledResolver(__ataCompiled${index}${extra})`)
          resolverCalls.add(call)
          done.add(call)
          continue
        }
      }
      let src = null
      try { src = compiledModuleFor(schema, { format: 'esm', order: true }) } catch { src = null }
      if (!src || !src.includes('function _ataOrder(')) continue
      const index = modules.length
      const fill = /\nfunction applyDefaults\(/.test(src)
      placeModule(`__ataCompiled${index}`, src, false, fill ? '{ validate, applyDefaults }' : '{ validate }')
      s.overwrite(call.start, call.end, `__ataCompiledResolver(__ataCompiled${index}${extra})`)
      resolverCalls.add(call)
      done.add(call)
    }
  }
  // zodResolver(schema): the schema is built here with the application's own
  // zod, a plan is made from it and held to zod on documents made for it
  // (src/zod-resolver.js), and only then is the call replaced. The constants
  // the schema is written in go with it, where nothing else in the file uses
  // them as values, so zod leaves the bundle; where something does, the call
  // stays as written.
  let zodDone = 0
  // Each zodResolver call left as written, with the reason, in the build's
  // report beside the validators kept on the runtime.
  const zodKeep = (call, reason) => { if (options && Array.isArray(options.kept)) options.kept.push({ line: call.loc ? call.loc.start.line : null, reason: `zodResolver(${call.arguments[0] && call.arguments[0].type === 'Identifier' ? call.arguments[0].name : '...'}): ${reason}`, zod: true }) }
  let zodRewrites = false
  let zodRefines = false
  let zodStrict = false
  // Schemas whose safeParse the build answers, and the constants that stand
  // for them in the file, written after the compiled modules.
  let parseDone = 0
  let zodFlat = false
  const zodSchemas = []
  const parseKeep = (call, name, reason) => { if (options && Array.isArray(options.kept)) options.kept.push({ line: call.loc ? call.loc.start.line : null, reason: `${name}.safeParse(): ${reason}`, zod: true, parse: true }) }
  if (zodFile && !virtual) {
    const zHere = zodFile.zod ? zodFor(id, zodFile.zod.source, zodFile.zod.kind) : null
    // A schema the file imports by name is read from the module it comes
    // from, as text: the module is not run, so it costs the build nothing but
    // a parse and has no effect on it. It has to be a file of the project
    // the build's own resolver finds, with zod under one name, and the
    // schema has to be made of zod and constants of that module.
    const named = new Map()
    for (const stmt of ast.program.body) if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type') for (const sp of stmt.specifiers) if (sp.type === 'ImportSpecifier' && sp.importKind !== 'type') named.set(sp.local.name, { stmt, sp, imported: sp.imported.name || sp.imported.value })
    const found = []
    // Where a schema's source comes from: the call itself, a constant of
    // the file, or a module the file imports it from by name; and the parts
    // any of those takes from other modules of the project, by name, read as
    // text through the build's resolver (src/zod-resolver.js schemaSource).
    // Every module on the way has to build with the same copy of zod.
    const sourceOf = (name, arg) => {
      const why = {}
      const ctx = options.resolveImport ? { resolve: (spec, from) => options.resolveImport(spec, from) || relativeResolve(spec, from) || workspaceResolve(spec, from), read: (file) => readModule(file, parse), file: id, depth: 0, stack: new Set(), zods: [] } : null
      const known = name === null || zodFile.consts.has(name) || (ctx !== null && zodFile.imports.has(name))
      const src = known ? schemaSource(name === null ? arg : name, zodFile, code, false, why, ctx) : null
      // Whether zod had a part in what was read: a name that comes from a
      // module with no zod in it is not a schema to report on.
      const zodModule = !!ctx && ctx.zods.length > 0
      let from = null
      if (src) {
        let z = zHere
        let same = !zodFile.zod || zHere !== null
        for (const m of ctx ? ctx.zods : []) {
          const zm = zodFor(m.file, m.source, m.kind)
          if (!zm || (z && zm.object !== z.object)) { same = false; break }
          z = z || zm
        }
        if (!same) why.why = zodFile.zod && zHere === null ? 'zod was not found from this file' : 'the schema is put together from modules that do not share one copy of zod'
        else if (!z) why.why = 'zod was not found from this file'
        else {
          const imp = name !== null && !zodFile.consts.has(name) ? src.imports.find((x) => x.name === name) : null
          from = { z, local: zodFile.zod ? zodFile.zod.local : null, text: src.text, names: src.names, imp: imp || null, parts: src.imports.filter((x) => x !== imp) }
        }
      }
      return from ? { from } : {
        zodModule,
        why: why.why !== undefined ? why.why
          : name === null || zodFile.consts.has(name) ? (zodFile.zod ? 'zod was not found from this file' : 'zod is not imported under one name (`import { z } from \'zod\'`)')
            : named.has(name) ? 'the schema is imported and the build has no resolver for it here'
              : `\`${name}\` is not a constant the build can read (a \`const\` of one name, at the top of the file or in a function)`,
      }
    }
    // The schema, built here from its source with the application's zod.
    const build = (from) => new Function('__ataZ', (from.local ? `const ${from.local} = __ataZ;\n` : '') + from.text)(from.z)
    for (const r of zodFile.resolver && wantResolver ? refs : []) {
      if (r.node.name !== zodFile.resolver.local || declared.get(zodFile.resolver.local) !== 1) continue
      const call = r.parent
      if (!call || call.type !== 'CallExpression' || r.key !== 'callee' || call.arguments.length < 1 || call.arguments[0].type === 'SpreadElement') continue
      if (call.arguments.length !== 1) { zodKeep(call, 'the call passes options, which have no compiled form'); continue }
      const arg = call.arguments[0]
      const name = arg.type === 'Identifier' ? arg.name : null
      if (name !== null && declared.get(name) !== 1) { zodKeep(call, `\`${name}\` is declared more than once`); continue }
      const { from, why } = sourceOf(name, arg)
      if (!from) { zodKeep(call, why); continue }
      let plan = null; let ir = null
      try {
        const schema = build(from)
        if (!schema || !schema._zod) { zodKeep(call, 'the schema is not a zod 4 schema'); continue }
        plan = planZod(schema)
        const check = new ata.Validator(plan.json, { richErrors: false })
        const differs = selfCheck(schema, plan, (d) => check.validate(d))
        if (differs !== null) { zodKeep(call, `the compiled check did not answer as zod (${differs.slice(0, 80)}); kept as written, and worth reporting`); continue }
        ir = irFor(plan.json, { richErrors: false }, false)
      } catch (e) { zodKeep(call, e && e.name === 'ZodRefused' ? e.message : `the schema could not be built here (${String(e && e.message).slice(0, 80)})`); continue }
      if (!ir) { zodKeep(call, 'ata-validator wrote no module for the schema'); continue }
      found.push({ call, names: from.names, imp: from.imp, parts: from.parts, plan, ir })
    }
    // name.safeParse(value): every use of the schema in the file has to be
    // such a call, and what each returns has to be read only through the
    // fields the page can give (src/error-use.js). The plan is then held to
    // zod's own safeParse, paths as zod writes them.
    if (wantParse) {
      const byName = new Map()
      for (const r of refs) {
        const m = r.parent
        if (!m || m.type !== 'MemberExpression' || r.key !== 'object' || m.computed || m.property.name !== 'safeParse') continue
        const call = m.__parent
        if (!call || call.type !== 'CallExpression' || call.callee !== m) continue
        const name = r.node.name
        if (!zodFile.consts.has(name) && !named.has(name)) continue
        if (!byName.has(name)) byName.set(name, [])
        byName.get(name).push({ ref: r.node, member: m, call })
      }
      for (const [name, uses] of byName) {
        const first = uses[0].call
        if (declared.get(name) !== 1) { parseKeep(first, name, `\`${name}\` is declared more than once`); continue }
        if (uses.some((u) => u.call.arguments.length !== 1 || u.call.arguments[0].type === 'SpreadElement')) { parseKeep(first, name, 'safeParse is called with other than one argument'); continue }
        const { from, why, zodModule } = sourceOf(name, null)
        // A name that is not a schema the build reads (an import from a
        // package, a value made at run time) is not zod's to report on.
        if (!from) { if (zodFile.consts.has(name) ? (!!zodFile.zod || zodModule) && !/^(?:Object|Array|(?:Arrow)?Function|Class|New)Expression$|Literal$/.test(zodFile.consts.get(name).init.type) : zodModule) parseKeep(first, name, why); continue }
        const flat = readsOnlyIssueFields(uses.map((u) => u.call), scan, zodFile.zod && declared.get(zodFile.zod.local) === 1 ? zodFile.zod.local : null)
        if (flat === null) { parseKeep(first, name, 'what it returns is used in a way the build does not follow: read through more than `success`, `data`, the `code`, `path` and `message` of each of `error.issues` and `error.flatten()`, or returned, stored or handed to a call'); continue }
        let plan = null; let ir = null
        try {
          const schema = build(from)
          if (!schema || !schema._zod) { parseKeep(first, name, 'the schema is not a zod 4 schema'); continue }
          plan = planZod(schema)
          const refused = parseRefusal(plan)
          if (refused) { parseKeep(first, name, refused); continue }
          const check = new ata.Validator(plan.json, { richErrors: false })
          // The safeParse mode alone: it makes the documents the resolver mode
          // makes and more, and compares each issue with its path, which holds
          // everything the other comparison does.
          const differs = selfCheck(schema, plan, (d) => check.validate(d), true)
          if (differs !== null) { parseKeep(first, name, `the compiled check did not answer as zod (${differs.slice(0, 80)}); kept as written, and worth reporting`); continue }
          ir = irFor(plan.json, { richErrors: false }, false)
        } catch (e) { parseKeep(first, name, e && e.name === 'ZodRefused' ? e.message : `the schema could not be built here (${String(e && e.message).slice(0, 80)})`); continue }
        if (!ir) { parseKeep(first, name, 'ata-validator wrote no module for the schema'); continue }
        found.push({ parse: true, name, uses, flat, call: first, names: from.names, imp: from.imp, parts: from.parts, plan, ir })
      }
    }
    // A constant or an import something else in the file uses as a value
    // cannot go, and neither can a call whose schema it is.
    let take = found
    const state = () => {
      const names = new Set(take.flatMap((f) => f.names))
      const removed = new Set([...names].map((n) => zodFile.consts.get(n).stmt))
      // A z.flattenError(...) the build rewrites no longer names zod.
      const calls = new Set(take.flatMap((f) => f.parse ? [...f.uses.map((u) => u.member), ...f.flat.filter((x) => x.call.arguments.length === 1).map((x) => x.call.callee)] : [f.call]))
      return { names, removed, calls, uses: usesOf(ast, new Set([...names, ...take.filter((f) => f.imp).map((f) => f.imp.name), ...take.flatMap((f) => f.parts.map((x) => x.name))]), removed, calls) }
    }
    for (;;) {
      const { uses } = state()
      const kept = take.filter((f) => f.names.every((n) => uses.get(n).values === 0 && declared.get(n) === 1) && (!f.imp || uses.get(f.imp.name).values === 0))
      if (kept.length === take.length) break
      for (const f of take) if (!kept.includes(f)) { if (f.parse) parseKeep(f.call, f.name, 'the schema is also used elsewhere in this file as a value (handed to a call, exported, or read through another method), so zod stays'); else zodKeep(f.call, 'the schema is also used as a value elsewhere in this file, so it cannot leave it') }
      take = kept
    }
    if (take.length) {
      const { removed, calls, uses } = state()
      const lit = (v) => JSON.stringify(v).replace(/[\u2028\u2029]/g, (c) => c === '\u2028' ? '\\u2028' : '\\u2029')
      for (const f of take) {
        const index = modules.length
        f.ir.place(index, f.ir.src, false)
        if (f.plan.rewrites) zodRewrites = true
        if (f.plan.refines) zodRefines = true
        if (f.plan.strict) zodStrict = true
        if (f.parse) {
          // The schema becomes a constant that answers safeParse, and each
          // use names it; a schema nothing calls any more leaves the bundle.
          const local = `__ataZS${index}`
          zodSchemas.push(`const ${local} = /*#__PURE__*/ __ataZSchema(__ataCompiled${index}, ${lit(f.plan.table)}, ${lit(f.plan.paths)}${f.plan.refines ? `, ${lit(f.plan.refines)}, [${f.plan.fns.map((fn) => `(${String(fn)})`).join(', ')}]` : ''});\n`)
          for (const u of f.uses) s.overwrite(u.ref.start, u.ref.end, local)
          // error.flatten() and z.flattenError(error) become one call on the error.
          for (const x of f.flat) {
            if (x.call.arguments.length === 1) s.overwrite(x.call.callee.start, x.call.callee.end, '__ataZFlat')
            else { s.appendLeft(x.error.start, '__ataZFlat('); s.overwrite(x.error.end, x.call.end, ')') }
            zodFlat = true
          }
          parseDone++
          continue
        }
        // A refine's function goes into the file as it is written.
        s.overwrite(f.call.start, f.call.end, `__ataZodResolver(__ataCompiled${index}, ${lit(f.plan.table)}, ${lit(f.plan.paths)}${f.plan.refines ? `, undefined, ${lit(f.plan.refines)}, [${f.plan.fns.map((fn) => `(${String(fn)})`).join(', ')}]` : ''})`)
        done.add(f.call)
        zodDone++
      }
      for (const stmt of removed) s.remove(stmt.start, stmt.end)
      // An imported schema: its name leaves the import, or stays as a type
      // where the file still infers one from it. A statement left with only
      // types becomes a type import, so the module is not loaded for them.
      const byStmt = new Map()
      for (const f of take) if (f.imp) { if (!byStmt.has(f.imp.stmt)) byStmt.set(f.imp.stmt, new Map()); byStmt.get(f.imp.stmt).set(f.imp.sp, uses.get(f.imp.name).types > 0) }
      // A part a schema took from another module: its name leaves the import
      // too where nothing else in the file uses it as a value, or the module
      // it comes from, and zod with it, would stay on the page for a name
      // nothing reads.
      for (const f of take) for (const x of f.parts) if (uses.get(x.name).values === 0 && declared.get(x.name) === 1) { if (!byStmt.has(x.stmt)) byStmt.set(x.stmt, new Map()); byStmt.get(x.stmt).set(x.sp, uses.get(x.name).types > 0) }
      for (const [stmt, taken] of byStmt) {
        if (!stmt.specifiers.every((sp) => sp.type === 'ImportSpecifier')) continue
        const kept = stmt.specifiers.filter((sp) => !taken.has(sp) || taken.get(sp)).map((sp) => { const imported = sp.imported.name || JSON.stringify(sp.imported.value); return { type: taken.has(sp) || sp.importKind === 'type', text: imported === sp.local.name ? imported : `${imported} as ${sp.local.name}` } })
        if (kept.length === 0) { s.remove(stmt.start, stmt.end); continue }
        const allTypes = kept.every((k) => k.type)
        s.overwrite(stmt.start, stmt.end, `import ${allTypes ? 'type ' : ''}{ ${kept.map((k) => (k.type && !allTypes ? 'type ' : '') + k.text).join(', ')} } from ${code.slice(stmt.source.start, stmt.source.end)}`)
      }
      // zod's import: gone where the file no longer names it, a type import
      // where only types do.
      const left = usesOf(ast, new Set([...(zodFile.resolver ? [zodFile.resolver.local] : []), ...(zodFile.zod ? [zodFile.zod.local] : [])]), removed, calls)
      if (zodFile.zod) {
        const zu = left.get(zodFile.zod.local)
        if (zu.values === 0 && declared.get(zodFile.zod.local) === 1) {
          if (zu.types === 0) s.remove(zodFile.zod.stmt.start, zodFile.zod.stmt.end)
          else s.overwrite(zodFile.zod.stmt.start, zodFile.zod.stmt.start + 6, 'import type')
        }
      }
      const ru = zodFile.resolver ? left.get(zodFile.resolver.local) : { values: 1, types: 0 }
      if (ru.values === 0 && ru.types === 0 && zodFile.resolver.stmt.specifiers.length === 1) s.remove(zodFile.resolver.stmt.start, zodFile.resolver.stmt.end)
    }
  }
  const rjsfDone = []
  for (const { container, schemaAttr } of forms) {
    const schema = staticValue(schemaAttr.expression, ctx)
    if (schema === NOT_STATIC || schema === null || typeof schema !== 'object' || Array.isArray(schema)) continue
    const text = JSON.stringify(schema)
    let src = null
    try { src = rjsfCompile(schema) } catch { src = null }
    if (typeof src !== 'string' || !src.includes('module.exports')) continue
    const index = modules.length
    // rjsf's runtime validator checks a copy of the form data
    // (cloneForValidation), so filling defaults never touches the form's own
    // object; each function here gets a copy the same way, keeping the
    // `errors` rjsf reads off it.
    modules.push(`const __ataCompiled${index} = /*#__PURE__*/ (() => {\nconst module = { exports: {} };\n${src}\nconst fns = module.exports;\nfor (const key of Object.keys(fns)) {\n  const fn = fns[key];\n  const copy = function (data) { const r = fn(data !== null && typeof data === 'object' ? structuredClone(data) : data); copy.errors = fn.errors; return r };\n  fns[key] = copy;\n}\nreturn fns;\n})();\nconst __ataRjsf${index} = /*#__PURE__*/ __ataCreatePrecompiledValidator(__ataCompiled${index}, JSON.parse(${JSON.stringify(text)}));\n`)
    s.overwrite(container.expression.start, container.expression.end, `__ataRjsf${index}`)
    rjsfDone.push(container.expression)
    done.add(container.expression)
  }
  // Every `new Validator(...)` the file keeps on the runtime, with the reason,
  // for the build's report: the one place a reader learns why the runtime is
  // still in the bundle.
  // Reported through `options.kept`, an array the caller passes; the return
  // value stays null when nothing was replaced.
  const kept = options && Array.isArray(options.kept) ? options.kept : []
  const keep = (expr, reason) => kept.push({ line: expr.loc ? expr.loc.start.line : null, reason })
  for (const r of refs) {
    if (!validatorName || r.node.name !== validatorName) continue
    const expr = r.parent
    if (!expr || expr.type !== 'NewExpression' || r.key !== 'callee') continue
    if (expr.arguments.length !== 1 && expr.arguments.length !== 2) { keep(expr, `the call has ${expr.arguments.length} arguments; one schema and at most one options object are replaced`); continue }
    let optionsArg = ''
    const shape = { plain: false }
    if (expr.arguments.length === 2) {
      optionsArg = compiledOptionsArg(expr.arguments[1], ctx, supportedOptions, ata.compiledPlain === true, shape)
      if (optionsArg === NOT_STATIC) { keep(expr, 'the options are not a literal the build can read, or name an option a compiled module cannot reproduce'); continue }
    }
    const binding = replaceableBinding(expr, ctx)
    if (!binding) { keep(expr, 'the validator is not a const used only through validate(), isValidObject(), validateJSON(), isValidJSON() or handed over as a value; a property read, an export, a return or a reassignment keeps the runtime'); continue }
    const schema = staticValue(expr.arguments[0], ctx)
    if (schema === NOT_STATIC || schema === null || typeof schema !== 'object' || Array.isArray(schema)) { keep(expr, 'the schema is not a value the build can read: an object literal, a const bound to one, the default import of a relative .json file, or defineSchema(...) around one'); continue }
    // Handed only to Standard Schema consumers: a module with plain errors and
    // the wrapper that carries `~standard` alone (ata.compiledStandardWrapper, 1.61.3 on).
    const standardOnly = binding.standardOnly === true
    const verdict = !standardOnly && ata.compiledVerdict === true && verdictOnly(binding.methods)
    // `richErrors: false`: the module writes its errors in that plain shape
    // and the plain wrapper hands them out, with no error pipeline in the
    // bundle. The plain wrapper has no JSON entry points; code that calls
    // them keeps the runtime.
    // `errorFields: 'auto'`: no option asked for rich or plain errors, and
    // the code reads each error only through the fields a plain error has
    // (src/error-use.js). The validator is then written as if it had been
    // given `richErrors: false`: the same answers in those fields, without
    // the rich pipeline. validateJSON() has no plain wrapper, and a
    // validator handed over is read by code the build does not see.
    if (!shape.plain && errorFields !== 'all' && ata.compiledPlain === true && !verdict && !standardOnly && !binding.handed &&
        binding.validateCalls.length > 0 && noJson(binding.methods) && !namesRichErrors(expr.arguments[1], ctx) && readsOnlyPlainFields(binding.validateCalls, scan)) {
      shape.plain = true
      optionsArg = optionsArg === '' ? '{"richErrors":false}' : '{"richErrors":false,' + optionsArg.slice(1)
    }
    const plain = shape.plain && !verdict && !standardOnly
    if (plain && !noJson(binding.methods)) { keep(expr, 'richErrors: false with validateJSON() or isValidJSON(), which the plain compiled wrapper does not have'); continue }
    // The `ir` option: a validator only called, never handed over, with no
    // option but richErrors, useDefaults and assertFormat, becomes a module
    // of the IR compiler and an object with the same two methods. A schema
    // the IR does not cover ("ir: ...") takes the path below.
    if (options && options.ir && ata.ir && !virtual && !standardOnly && !binding.handed && [...binding.methods].every((m) => m === 'validate' || m === 'isValidObject')) {
      let opts = null
      try { opts = optionsArg ? JSON.parse(optionsArg) : {} } catch { opts = null }
      if (opts && Object.keys(opts).every((k) => (k === 'richErrors' || k === 'useDefaults' || k === 'assertFormat') && typeof opts[k] === 'boolean')) {
        const callsOnly = [...binding.methods].every((m) => m === 'isValidObject')
        const validOnly = !callsOnly && errorFields !== 'all' && binding.validateCalls.length > 0 && readsOnlyValid(binding.validateCalls, scan)
        // Verdict functions always: validate() answers a valid document with
        // them before it gathers any error, and without them that answer
        // runs the error-gathering functions with no list. On SchemaStore's
        // samples that made a valid validate() 1.46x the previous module at
        // the median and the first call 0.38 against 0.21 ms, for about 7%
        // more bytes (8.2 against 7.6 KB gzipped at the median).
        // fillSource: the runtime's generated defaults pass, written in where
        // the IR's own fill declines (on SchemaStore 0.56 of the time on the
        // 22 schemas it changes, slower on none).
        const ir = irFor(schema, { richErrors: opts.richErrors !== false, useDefaults: opts.useDefaults !== false, assertFormat: opts.assertFormat !== false }, callsOnly, expr)
        if (ir) {
          const index = modules.length
          // A table plan runs on one interpreter that has its errors anyway.
          const verdictOnly = callsOnly || (validOnly && ir.place !== placeTable)
          ir.place(index, ir.src, verdictOnly, validOnly && !callsOnly)
          if (verdictOnly) kinds.verdict++; else if (opts.richErrors === false) kinds.plain++; else kinds.errors++
          s.overwrite(expr.start, expr.end, `__ataCompiled${index}`)
          done.add(expr)
          continue
        }
      }
    }
    let src = null
    // A verdict wrapper only ever calls isValid: the module is written without
    // its error collector (`verdictOnly`, 1.61.1 on; older versions ignore it).
    try { src = compiledModuleFor(schema, plain || standardOnly ? { format: 'esm', plainErrors: true } : verdict ? { format: 'esm', verdictOnly: true } : { format: 'esm' }) } catch { src = null }
    if (!src) { keep(expr, 'ata-validator declines to compile this schema standalone (a custom error message, or a shape its error generator cannot express exactly)'); continue }
    const index = modules.length
    // `verify` holds the self-contained module against the runtime; a compact
    // module shares its verdict function with it and imports the runtime.
    // verify compares errors too, so it gets the module with its collector.
    if (options && options.verifying instanceof Map) {
      let full = src
      if (verdict) { try { full = compiledModuleFor(schema, { format: 'esm' }) || src } catch { full = src } }
      options.verifying.set(`${id}:${expr.loc ? expr.loc.start.line : '?'}`, { schema, src: full })
    }
    // Code that never reads errors gets the verdict wrapper and no errors at
    // all, so a compact module would only add the runtime.
    // A virtual module cannot resolve the shared error runtime's bare import
    // from nowhere, so it stays self-contained.
    const compact = verdict || virtual || plain ? null : compactModuleFor(schema, src, ata, sharedErrors, collect)
    if (compact) { src = compact; usesRuntime = true; if (compact.includes('_ataCompileSafe')) usesSafeRe = true }
    const object = !verdict && !plain && ata.compiledObject === true && noJson(binding.methods)
    // Called only, never handed to other code (`ata.compiledBare`, 1.61.1 on):
    // nothing reads `~standard` or registers a check on it, so a bare wrapper
    // does, the verdict and the plain errors without that API surface. It
    // reads only these of the module, so the rest is cut.
    if (standardOnly) {
      wrappers.standard = true
      kinds.standard++
      const useDefaults = /"useDefaults":false/.test(optionsArg) ? ', false' : ''
      placeModule(`__ataCompiled${index}`, src, false, `{ validate, isValid${DEFAULTS_EXPORT.test(src) && !useDefaults ? ', applyDefaults' : ''} }`)
      // The schema as written: `~standard.jsonSchema` hands it out as the runtime does.
      s.overwrite(expr.start, expr.end, `__ataBareStandard(__ataCompiled${index}, ${JSON.stringify(schema)}${useDefaults})`)
      done.add(expr)
      continue
    }
    const onlyCalled = !binding.handed && [...binding.methods].every((m) => m === 'validate' || m === 'isValidObject')
    const bare = ata.compiledBare === true && !binding.handed && (verdict || (plain && onlyCalled))
    // The same for a validator that reads ata's own errors (`ata.compiledBareRich`).
    const bareRich = !bare && !verdict && !plain && !compact && ata.compiledBareRich === true && onlyCalled
    const fills = DEFAULTS_EXPORT.test(src) && !/"useDefaults":false/.test(optionsArg)
    placeModule(`__ataCompiled${index}`, src, verdict, bare || bareRich ? `{ ${verdict ? '' : 'validate, '}isValid${fills ? ', applyDefaults' : ''} }` : undefined)
    if (bareRich) {
      wrappers.bareRich = true
      kinds.errors++
      const useDefaults = /"useDefaults":false/.test(optionsArg) ? ', false' : ''
      s.overwrite(expr.start, expr.end, `__ataBareRich(__ataCompiled${index}, ${JSON.stringify(compiledSchemaFor(schema))}${useDefaults})`)
      done.add(expr)
      continue
    }
    if (bare) {
      wrappers.bare = true
      if (verdict) kinds.verdict++; else kinds.plain++
      const useDefaults = /"useDefaults":false/.test(optionsArg) ? ', false' : ''
      s.overwrite(expr.start, expr.end, `${verdict ? '__ataBareVerdict' : '__ataBarePlain'}(__ataCompiled${index}${useDefaults})`)
      done.add(expr)
      continue
    }
    const wrap = verdict ? '__ataFromCompiledVerdict' : plain ? '__ataFromCompiledPlain' : object ? '__ataFromCompiledObject' : '__ataFromCompiled'
    if (verdict) wrappers.verdict = true; else if (plain) wrappers.plain = true; else if (object) wrappers.object = true; else wrappers.full = true
    if (verdict) kinds.verdict++; else if (plain) kinds.plain++; else kinds.errors++
    // The verdict wrapper takes no richErrors option: errors are not read there.
    const arg = verdict && shape.plain ? optionsArg.replace(/"richErrors":false,?/, '').replace(/^\{\}$/, '') : optionsArg
    s.overwrite(expr.start, expr.end, `${wrap}(__ataCompiled${index}, ${JSON.stringify(compiledSchemaFor(schema))}${arg ? ', ' + arg : ''})`)
    done.add(expr)
  }
  // schemaOf<T>() calls left outside a replaced expression become the schema
  // as a literal (parsed from JSON text: a literal would make a "__proto__"
  // key the object's prototype).
  for (const [call, schema] of typeSchemas) {
    let inside = false
    for (const e of done) if (call.start >= e.start && call.end <= e.end) { inside = true; break }
    if (inside) continue
    s.overwrite(call.start, call.end, `JSON.parse(${JSON.stringify(JSON.stringify(schema))})`)
    done.add(call)
  }
  if (done.size === 0 && parseDone === 0) return null

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
  if (importDecl) prune(importDecl, [validatorName, defineSchema, schemaOfName].filter(Boolean))
  if (resolverImport && resolverCalls.size) prune(resolverImport, [resolverName])
  // The default import of @rjsf/validator-ata goes when no use of it is left,
  // and with it the runtime validator.
  if (rjsfImport && rjsfDone.length) {
    if (!refs.some((r) => r.node.name === rjsfName && !inReplaced(r.node))) {
      if (rjsfImport.specifiers.length === 1) s.remove(rjsfImport.start, rjsfImport.end)
      else {
        const named = rjsfImport.specifiers.filter((sp) => sp.type === 'ImportSpecifier').map((sp) => code.slice(sp.start, sp.end))
        s.overwrite(rjsfImport.start, rjsfImport.end, named.length ? `import { ${named.join(', ')} } from ${code.slice(rjsfImport.source.start, rjsfImport.source.end)}` : '')
      }
    }
    addImport(`import __ataCreatePrecompiledValidator from '@rjsf/validator-ata/lib/createPrecompiledValidator.js';\n`)
  }
  // The builder calls read here are pure, and marked so: a schema constant
  // only the replaced call used, and the builder with it, can then leave the
  // bundle.
  for (const call of ctx.tCalls) s.appendLeft(call.start, '/*#__PURE__*/ ')
  if (resolverCalls.size) addImport(resolverKind === 'own' ? OWN_RESOLVER : `import { ataCompiledResolver as __ataCompiledResolver } from '${RESOLVERS}';\n`)
  if (zodDone || parseDone) addImport((zodDone ? ZOD_RUNTIME_IMPORTS : '') + zodRuntimeFor(zodRewrites, zodRefines, zodStrict, zodDone > 0, parseDone > 0, zodFlat))
  if (wrappers.verdict) addImport(`import { fromCompiledVerdict as __ataFromCompiledVerdict } from 'ata-validator/compiled-verdict';\n`)
  if (wrappers.full) addImport(`import { fromCompiled as __ataFromCompiled } from 'ata-validator/compiled';\n`)
  if (wrappers.object) addImport(`import { fromCompiledObject as __ataFromCompiledObject } from 'ata-validator/compiled-object';\n`)
  if (wrappers.plain) addImport(`import { fromCompiledPlain as __ataFromCompiledPlain } from 'ata-validator/compiled-plain';\n`)
  if (wrappers.standard) addImport(`import { bareStandard as __ataBareStandard } from 'ata-validator/compiled-standard';\n`)
  if (wrappers.bareRich) addImport(`import { bareRich as __ataBareRich } from 'ata-validator/compiled-bare-rich';\n`)
  if (wrappers.bare) addImport(`import { bareVerdict as __ataBareVerdict, barePlain as __ataBarePlain } from 'ata-validator/compiled-bare';\n`)
  // compileSafe is the pattern engine a compact module with a pattern the
  // platform RegExp does not run takes from the runtime instead of embedding.
  if (irKernels.size) addImport(`import { ${[...irKernels].sort().map((n) => `${n} as __ataK_${n}`).join(', ')} } from 'ata-validator/kernels';\n`)
  if (usesRuntime) addImport(`import { createErrors as _ataCreateErrors${usesSafeRe ? ', compileSafe as _ataCompileSafe' : ''} } from '${ERROR_RUNTIME}';\n`)
  if (virtualImports.length) addImport(virtualImports.join(''))
  s.appendLeft(lastImportEnd, '\n' + modules.join('') + zodSchemas.join(''))
  return { code: s.toString(), map: s.generateMap({ hires: true, source: id, includeContent: true }), replaced: done.size, kinds, zod: zodDone, zodParse: parseDone }
}
