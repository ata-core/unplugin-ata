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
  let handed = false
  // Handed only to Standard Schema consumers the build knows (ctx.standardConsumers).
  let handedStandard = false
  for (const r of ctx.refs) {
    if (r.node.name !== name) continue
    if (r.node === decl.id) continue
    const p = r.parent
    const member = p && (p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && r.key === 'object' && !p.computed && p.property.type === 'Identifier' && METHODS.has(p.property.name)
    const called = member && p.__parent && (p.__parent.type === 'CallExpression' || p.__parent.type === 'OptionalCallExpression') && p.__parent.callee === p
    if (called) { methods.add(p.property.name); continue }
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
  return { name, methods, handed, standardOnly }
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

export function compileAway(code, id, ata, options) {
  const sharedErrors = options && options.sharedErrors !== undefined ? options.sharedErrors : 'auto'
  const collect = options && Array.isArray(options.collect) ? options.collect : null
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
  if (!code.includes('ata-validator') && !code.includes('@rjsf/validator-ata')) return null
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
      if (imported === 'schemaOf') { schemaOfName = s.local.name; if (!importDecl) importDecl = stmt }
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
  if (!validatorName && !resolverName && !rjsfName && !schemaOfName) return null
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
  if (!validatorName && !resolverName && !rjsfName && typeSchemas.size === 0) return null
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
  const modules = []
  const done = new Set()
  const wrappers = { full: false, verdict: false, object: false, plain: false, bare: false, bareRich: false, standard: false }
  // How many calls took each wrapper, for the build report.
  const kinds = { standard: 0, verdict: 0, plain: 0, errors: 0 }
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
      placeModule(`__ataCompiled${index}`, src, false, fill ? '{ validate, applyDefaults }' : '{ validate }')
      s.overwrite(call.start, call.end, `__ataCompiledResolver(__ataCompiled${index}${extra})`)
      resolverCalls.add(call)
      done.add(call)
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
    const plain = shape.plain && !verdict && !standardOnly
    if (plain && !noJson(binding.methods)) { keep(expr, 'richErrors: false with validateJSON() or isValidJSON(), which the plain compiled wrapper does not have'); continue }
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
    s.prepend(`import __ataCreatePrecompiledValidator from '@rjsf/validator-ata/lib/createPrecompiledValidator.js';\n`)
  }
  // The builder calls read here are pure, and marked so: a schema constant
  // only the replaced call used, and the builder with it, can then leave the
  // bundle.
  for (const call of ctx.tCalls) s.appendLeft(call.start, '/*#__PURE__*/ ')
  if (resolverCalls.size) s.prepend(`import { ataCompiledResolver as __ataCompiledResolver } from '${RESOLVERS}';\n`)
  if (wrappers.verdict) s.prepend(`import { fromCompiledVerdict as __ataFromCompiledVerdict } from 'ata-validator/compiled-verdict';\n`)
  if (wrappers.full) s.prepend(`import { fromCompiled as __ataFromCompiled } from 'ata-validator/compiled';\n`)
  if (wrappers.object) s.prepend(`import { fromCompiledObject as __ataFromCompiledObject } from 'ata-validator/compiled-object';\n`)
  if (wrappers.plain) s.prepend(`import { fromCompiledPlain as __ataFromCompiledPlain } from 'ata-validator/compiled-plain';\n`)
  if (wrappers.standard) s.prepend(`import { bareStandard as __ataBareStandard } from 'ata-validator/compiled-standard';\n`)
  if (wrappers.bareRich) s.prepend(`import { bareRich as __ataBareRich } from 'ata-validator/compiled-bare-rich';\n`)
  if (wrappers.bare) s.prepend(`import { bareVerdict as __ataBareVerdict, barePlain as __ataBarePlain } from 'ata-validator/compiled-bare';\n`)
  // compileSafe is the pattern engine a compact module with a pattern the
  // platform RegExp does not run takes from the runtime instead of embedding.
  if (usesRuntime) s.prepend(`import { createErrors as _ataCreateErrors${usesSafeRe ? ', compileSafe as _ataCompileSafe' : ''} } from '${ERROR_RUNTIME}';\n`)
  if (virtualImports.length) s.prepend(virtualImports.join(''))
  s.appendLeft(lastImportEnd, '\n' + modules.join(''))
  return { code: s.toString(), map: s.generateMap({ hires: true, source: id, includeContent: true }), replaced: done.size, kinds }
}
