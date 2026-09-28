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

import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import MagicString from 'magic-string'

const METHODS = new Set(['validate', 'isValidObject', 'validateJSON', 'isValidJSON'])
const NOT_STATIC = Symbol('not static')

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
    case 'CallExpression':
      if (node.callee.type === 'Identifier' && node.callee.name === ctx.defineSchema && node.arguments.length === 1) return staticValue(node.arguments[0], ctx, seen)
      return NOT_STATIC
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
  const decl = newExpr.__parent
  if (!decl || decl.type !== 'VariableDeclarator' || decl.init !== newExpr || decl.id.type !== 'Identifier') return null
  const list = decl.__parent
  if (!list || list.type !== 'VariableDeclaration' || list.kind !== 'const') return null
  if (list.__parent && list.__parent.type === 'ExportNamedDeclaration') return null
  const name = decl.id.name
  if (ctx.declared.get(name) !== 1) return null
  for (const r of ctx.refs) {
    if (r.node.name !== name) continue
    const p = r.parent
    const member = p && (p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && r.key === 'object' && !p.computed && p.property.type === 'Identifier' && METHODS.has(p.property.name)
    const called = member && p.__parent && (p.__parent.type === 'CallExpression' || p.__parent.type === 'OptionalCallExpression') && p.__parent.callee === p
    if (!called) return null
  }
  return name
}

function inlineModule(src, index) {
  const body = src.split('\n').filter((l) => !/^export\s/.test(l)).join('\n')
  return `const __ataCompiled${index} = (() => {\n${body}\nreturn { validate, isValid };\n})();\n`
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

export function compileAway(code, id, ata) {
  const { compiledModuleFor, compiledSchemaFor } = ata
  const supportedOptions = Array.isArray(ata.compiledOptions) ? ata.compiledOptions : []
  if (!code.includes('ata-validator')) return null
  let ast
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: false })
  } catch {
    return null
  }
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
  if (!validatorName) return null

  const { declared, refs } = scan(ast)
  if (declared.get(validatorName) !== 1) return null
  const ctx = { declared, refs, constants: constantsOf(ast, id), defineSchema }

  const s = new MagicString(code)
  const modules = []
  const done = new Set()
  for (const r of refs) {
    if (r.node.name !== validatorName) continue
    const expr = r.parent
    if (!expr || expr.type !== 'NewExpression' || r.key !== 'callee') continue
    if (expr.arguments.length !== 1 && expr.arguments.length !== 2) continue
    let optionsArg = ''
    if (expr.arguments.length === 2) {
      optionsArg = compiledOptionsArg(expr.arguments[1], ctx, supportedOptions)
      if (optionsArg === NOT_STATIC) continue
    }
    if (!replaceableBinding(expr, ctx)) continue
    const schema = staticValue(expr.arguments[0], ctx)
    if (schema === NOT_STATIC || schema === null || typeof schema !== 'object' || Array.isArray(schema)) continue
    let src = null
    try { src = compiledModuleFor(schema, { format: 'esm' }) } catch { src = null }
    if (!src) continue
    const index = modules.length
    modules.push(inlineModule(src, index))
    s.overwrite(expr.start, expr.end, `__ataFromCompiled(__ataCompiled${index}, ${JSON.stringify(compiledSchemaFor(schema))}${optionsArg ? ', ' + optionsArg : ''})`)
    done.add(expr)
  }
  if (done.size === 0) return null

  // `Validator`, and `defineSchema` when it only wrapped a replaced schema,
  // leave the import once nothing else uses them, and the import goes when it
  // is left empty, so no bundler has to prove the runtime unused.
  const inReplaced = (node) => { for (const e of done) if (node.start >= e.start && node.end <= e.end) return true; return false }
  const unused = new Set()
  for (const spec of importDecl.specifiers) {
    if (spec.type !== 'ImportSpecifier') continue
    const name = spec.local.name
    if (name !== validatorName && name !== defineSchema) continue
    if (ctx.declared.get(name) !== 1) continue
    if (!refs.some((r) => r.node.name === name && !inReplaced(r.node))) unused.add(spec)
  }
  if (unused.size === importDecl.specifiers.length) s.remove(importDecl.start, importDecl.end)
  else if (unused.size) {
    const kept = importDecl.specifiers.filter((sp) => !unused.has(sp))
    const text = (sp) => code.slice(sp.start, sp.end)
    const def = kept.find((sp) => sp.type === 'ImportDefaultSpecifier')
    const named = kept.filter((sp) => sp.type === 'ImportSpecifier')
    const clause = [def ? text(def) : null, named.length ? `{ ${named.map(text).join(', ')} }` : null].filter(Boolean).join(', ')
    s.overwrite(importDecl.start, importDecl.end, `import ${clause} from ${code.slice(importDecl.source.start, importDecl.source.end)}`)
  }
  s.prepend(`import { fromCompiled as __ataFromCompiled } from 'ata-validator/compiled';\n`)
  s.appendLeft(lastImportEnd, '\n' + modules.join(''))
  return { code: s.toString(), map: s.generateMap({ hires: true, source: id, includeContent: true }), replaced: done.size }
}
