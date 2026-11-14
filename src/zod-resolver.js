// `zodResolver(schema)` from @hookform/resolvers/zod, compiled away.
//
// A form that keeps its zod schema and its zodResolver call can still ship
// without zod: the build reads the schema, writes a JSON Schema that gives the
// same verdict, and for each rule records the issue zod reports when it is
// broken (code and message, a custom message included), learned by handing zod
// itself a value that breaks that one rule. On the page a compiled check runs,
// and its errors are turned into zod's issues from those tables
// (src/zod-resolver-rt.js), in zod's order, through the resolver's own
// mapping to field errors.
//
// Nothing is replaced on trust. planZod() refuses what it does not know
// (ZodRefused), and selfCheck() then runs the plan beside the real schema on
// documents made for it and compares issues and returned data; a call is
// replaced only when both hold. A refused or failing schema keeps its
// zodResolver call and zod stays on the page, as before.
//
// Carried: an object of strings (min, max, length, email, regex and the other
// formats zod checks with a pattern), numbers (int, min, max, gt, lt,
// positive and the like), booleans, enums, literals, optional fields and
// nested objects. Refused: arrays, unions, nullable, url, refine, transform,
// default, coerce, trim and the like, strict and passthrough objects, zod 3.
import fs from 'node:fs'
import { createRequire } from 'node:module'

export const ZOD_RESOLVERS = '@hookform/resolvers/zod'
export const ZOD_RUNTIME = fs.readFileSync(new URL('./zod-resolver-rt.js', import.meta.url), 'utf8').replace(/^\/\/[^\n]*\n/gm, '')
export const ZOD_RUNTIME_IMPORTS = "import { toNestErrors as __ataZNest, validateFieldsNatively as __ataZNative } from '@hookform/resolvers';\nimport { appendErrors as __ataZAppend } from 'react-hook-form';\n"
// The same text as functions of this process: selfCheck uses the issue list
// and the returned data, and a test builds the whole resolver from it with
// the real toNestErrors, validateFieldsNatively and appendErrors.
export const zodRuntime = (nest, native, append) => new Function('__ataZNest', '__ataZNative', '__ataZAppend', ZOD_RUNTIME + '\nreturn { issues: __ataZIssues, strip: __ataZStrip, resolver: __ataZodResolver }')(nest, native, append)
const RT = zodRuntime(null, null, null)

const MAX_SAFE = Number.MAX_SAFE_INTEGER
export class ZodRefused extends Error {}
const no = (why) => { throw new ZodRefused(why) }
const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1')

const issuesOf = (node, v) => { const r = node.safeParse(v); return r.success ? [] : r.error.issues }
const one = (node, v, pick, what) => { const hit = issuesOf(node, v).filter(pick); if (hit.length !== 1) no(`${what}: zod reported ${hit.length} matching issues for the probe`); return [hit[0].code, hit[0].message] }

// The type rule of a leaf: a custom message is one zod gives whatever came.
const DEFAULT_TYPE = /^Invalid input: expected (\w+), received /
function typeEntry (node, expected, probes) {
  const msgs = probes.map((p) => { const i = issuesOf(node, p).filter((x) => x.code === 'invalid_type' && x.expected === expected); if (i.length !== 1) no(`type of ${expected}: no single invalid_type issue`); return i[0].message })
  if (msgs.every((m) => m === msgs[0]) && !DEFAULT_TYPE.test(msgs[0])) return { m: msgs[0] }
  if (!msgs.every((m) => { const d = DEFAULT_TYPE.exec(m); return d && d[1] === expected })) no(`type of ${expected}: a message that depends on the value`)
  return { x: expected }
}

export function planZod (schema) {
  const table = {}      // schemaPath -> [rank, code, message] | { type entries }
  const paths = {}      // instancePath -> { o: order, u: [code, message] when undefined }
  let order = 0
  const walk = (node, sp, ip) => {
    let def = node._zod.def
    let optional = false
    if (def.type === 'optional') { optional = true; node = def.innerType; def = node._zod.def }
    const here = paths[ip] = { o: order++ }
    if (!optional) { const u = issuesOf(node, undefined); if (u.length !== 1) no(`${ip}: ${u.length} issues for a missing value`); here.u = [u[0].code, u[0].message] }
    const out = {}
    const dup = new Set()
    const put = (kw, value, entry) => {
      if (dup.has(kw)) { (out.allOf || (out.allOf = [])).push({ [kw]: value }); table[`${sp}/allOf/${out.allOf.length - 1}/${kw}`] = entry } else { dup.add(kw); out[kw] = value; table[`${sp}/${kw}`] = entry }
    }
    const checks = def.checks || []
    if (def.type === 'string') {
      const len = []
      out.type = 'string'; table[`${sp}/type`] = { t: typeEntry(node, 'string', [null, 1, true, {}]), l: len }
      // zod runs a length check on anything that has a length, a string or
      // not, and words the default message by what it was given.
      const origins = (n, pick, what) => [one(node, new Array(n).fill(0), pick, what), one(node, { length: n }, pick, what)].map((x) => x[1])
      checks.forEach((c, rank) => {
        const d = c._zod.def
        if (d.check === 'min_length' && d.minimum >= 1) len.push([0, d.minimum, rank, 'too_small', ...origins(d.minimum - 1, (i) => i.code === 'too_small' && i.minimum === d.minimum, 'min')])
        if (d.check === 'max_length') len.push([1, d.maximum, rank, 'too_big', ...origins(d.maximum + 1, (i) => i.code === 'too_big' && i.maximum === d.maximum, 'max')])
        if (d.check === 'length_equals') { if (d.length >= 1) len.push([0, d.length, rank, 'too_small', ...origins(d.length - 1, (i) => i.code === 'too_small' && i.exact === true, 'length')]); len.push([1, d.length, rank, 'too_big', ...origins(d.length + 1, (i) => i.code === 'too_big' && i.exact === true, 'length')]) }
        if (d.check === 'min_length') { if (d.minimum < 1) return; put('minLength', d.minimum, [rank, ...one(node, 'a'.repeat(d.minimum - 1), (i) => i.code === 'too_small' && i.minimum === d.minimum, 'min')]) }
        else if (d.check === 'max_length') { if (d.maximum > 100000) no('a very long maximum'); put('maxLength', d.maximum, [rank, ...one(node, 'a'.repeat(d.maximum + 1), (i) => i.code === 'too_big' && i.maximum === d.maximum, 'max')]) }
        else if (d.check === 'length_equals') {
          if (d.length > 100000) no('a very long length')
          if (d.length >= 1) put('minLength', d.length, [rank, ...one(node, 'a'.repeat(d.length - 1), (i) => i.code === 'too_small' && i.exact === true, 'length')])
          put('maxLength', d.length, [rank, ...one(node, 'a'.repeat(d.length + 1), (i) => i.code === 'too_big' && i.exact === true, 'length')])
        } else if (d.check === 'string_format' && d.pattern instanceof RegExp && (d.pattern.flags === '' || d.pattern.flags === 'u')) {
          const bad = ['', ' ', '\u0000', 'x', '@', '0'].find((s) => !d.pattern.test(s))
          if (bad === undefined) no('a pattern no probe breaks')
          put('pattern', d.pattern.source, [rank, ...one(node, bad, (i) => i.code === 'invalid_format' && i.format === d.format, 'format')])
        } else no(`string check ${d.check}${d.format ? ' ' + d.format : ''}`)
      })
    } else if (def.type === 'number') {
      const fmt = checks.filter((c) => c._zod.def.check === 'number_format')
      if (fmt.length > 1 || (fmt.length === 1 && fmt[0]._zod.def.format !== 'safeint')) no('a number format other than int')
      out.type = fmt.length ? 'integer' : 'number'
      const t = { t: typeEntry(node, 'number', [null, 'a', true, {}]) }
      if (fmt.length) t.i = [checks.indexOf(fmt[0]), ...one(node, 0.5, (i) => i.code === 'invalid_type' && i.expected === 'int', 'int')]
      table[`${sp}/type`] = t
      checks.forEach((c, rank) => {
        const d = c._zod.def
        if (d.check === 'number_format') {
          put('maximum', MAX_SAFE, [rank, ...one(node, 2 ** 60, (i) => i.code === 'too_big' && i.maximum === MAX_SAFE, 'int upper')])
          put('minimum', -MAX_SAFE, [rank, ...one(node, -(2 ** 60), (i) => i.code === 'too_small' && i.minimum === -MAX_SAFE, 'int lower')])
        } else if (d.check === 'greater_than' && typeof d.value === 'number') put(d.inclusive ? 'minimum' : 'exclusiveMinimum', d.value, [rank, ...one(node, d.value - 1, (i) => i.code === 'too_small' && i.minimum === d.value, 'min')])
        else if (d.check === 'less_than' && typeof d.value === 'number') put(d.inclusive ? 'maximum' : 'exclusiveMaximum', d.value, [rank, ...one(node, d.value + 1, (i) => i.code === 'too_big' && i.maximum === d.value, 'max')])
        else no(`number check ${d.check}`)
      })
    } else if (def.type === 'boolean') {
      if (checks.length) no('a check on a boolean')
      out.type = 'boolean'; table[`${sp}/type`] = { t: typeEntry(node, 'boolean', [null, 'a', 1, {}]) }
    } else if (def.type === 'enum' || def.type === 'literal') {
      if (checks.length) no('a check on an enum')
      const values = def.type === 'enum' ? Object.values(def.entries) : def.values
      if (!values.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean')) no('an enum value that is not a string, number or boolean')
      out.enum = values
      const probes = [null, '\u0000 not a member', -0.123456789, {}].map((p) => issuesOf(node, p))
      if (!probes.every((i) => i.length === 1 && i[0].code === probes[0][0].code && i[0].message === probes[0][0].message)) no('an enum message that depends on the value')
      table[`${sp}/enum`] = [0, probes[0][0].code, probes[0][0].message]
    } else if (def.type === 'object') {
      if (checks.length || def.catchall) no('an object with checks or a catchall')
      out.type = 'object'; table[`${sp}/type`] = { t: typeEntry(node, 'object', [null, 'a', 1, true]) }
      out.properties = {}; const required = []; here.k = Object.keys(def.shape)
      for (const k of here.k) {
        if (k === '__proto__') no('a __proto__ key')
        const child = def.shape[k]
        if (child._zod.def.type !== 'optional') required.push(k)
        out.properties[k] = walk(child, `${sp}/properties/${esc(k)}`, `${ip}/${esc(k)}`)
      }
      if (required.length) out.required = required
    } else no(`a ${def.type}`)
    return out
  }
  if (schema._zod.def.type !== 'object') no('a root that is not an object')
  const json = walk(schema, '#', '')
  return { json, table, paths }
}

// The zod a file imports, as that file resolves it: the value its local name
// stands for, or null (not zod 4, not found).
export function zodFor (file, source, kind) {
  try {
    const mod = createRequire(file)(source)
    const z = kind === 'named' ? mod.z : kind === 'default' ? (mod.default || mod) : mod
    return z && typeof z.object === 'function' ? z : null
  } catch { return null }
}

// A value of each kind a form can hand a field, and values that pass a leaf.
const POOL = [undefined, null, '', ' ', 'a', 'ab', 'abc', 'abcdefghijklmnopqrstuvwxyz0123456789', 'a@b.co', 'A1b2c3d4', '12345', '123e4567-e89b-42d3-a456-426614174000', 0, 1, -1, 0.5, 17, 18, 100, 1e9, 2 ** 60, NaN, Infinity, true, false, [], ['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'], {}, { length: 1 }, { length: 99 }, new Date(0)]
const show = (x) => JSON.stringify(x, (k, v) => v === undefined ? '\u0000undefined' : typeof v === 'number' && !Number.isFinite(v) ? '\u0000' + String(v) : v)

// Whether the plan answers as the schema does: zod's issues (path, code,
// message, in order) and the data it returns, on a document that passes, on
// that document with each field in turn missing and holding each value of
// the pool, and on documents with several fields wrong. `validate` is the
// check compiled from plan.json with plain errors.
export function selfCheck (schema, plan, validate) {
  const leaves = []
  const good = (node, ip) => {
    let def = node._zod.def; let optional = false
    if (def.type === 'optional') { optional = true; node = def.innerType; def = node._zod.def }
    if (def.type === 'object') { const out = {}; for (const [k, child] of Object.entries(def.shape)) out[k] = good(child, ip.concat(k)); return out }
    const candidates = def.type === 'enum' ? Object.values(def.entries) : def.type === 'literal' ? def.values : POOL
    const ok = candidates.find((c) => c !== undefined && node.safeParse(c).success)
    if (ok === undefined && !optional) throw new ZodRefused('no value of the pool passes ' + ip.join('.'))
    leaves.push(ip)
    return ok
  }
  const base = good(schema, [])
  const copy = (d) => { if (d === null || typeof d !== 'object' || Array.isArray(d) || Object.getPrototypeOf(d) !== Object.prototype) return d; const o = {}; for (const k of Object.keys(d)) o[k] = copy(d[k]); return o }
  const set = (d, ip, v, drop) => { const o = copy(d); let at = o; for (let i = 0; i < ip.length - 1; i++) at = at[ip[i]]; if (drop) delete at[ip[ip.length - 1]]; else at[ip[ip.length - 1]] = v; return o }
  const docs = [base, {}, { ...copy(base), ['\u0000extra']: 1 }]
  for (const ip of leaves) { docs.push(set(base, ip, undefined, true)); for (const v of POOL) docs.push(set(base, ip, v, false)) }
  // Parents of leaves, wrong as a whole.
  const parents = new Set(leaves.filter((ip) => ip.length > 1).map((ip) => JSON.stringify(ip.slice(0, -1))))
  for (const p of parents) for (const v of [undefined, null, 'a', 1, [], {}]) docs.push(set(base, JSON.parse(p), v, false))
  // Several fields wrong at once, by a fixed sequence.
  let seed = 7; const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n }
  for (let i = 0; i < 60 && leaves.length > 1; i++) { let d = base; for (const ip of leaves) if (next(3) === 0) d = set(d, ip, POOL[next(POOL.length)], next(5) === 0); docs.push(d) }
  for (const d of docs) {
    const want = schema.safeParse(copy(d))
    const got = validate(copy(d))
    if (want.success !== got.valid) return `verdict on ${show(d)}`
    if (want.success) { if (show(want.data) !== show(RT.strip(plan.paths, '', d))) return `data on ${show(d)}`; continue }
    const mine = RT.issues(got.errors, plan.table, plan.paths, d)
    const theirs = want.error.issues.map((i) => ['' + i.path.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join(''), i.code, i.message])
    if (show(mine) !== show(theirs)) return `issues on ${show(d)}`
  }
  return null
}

// --- reading a file ---------------------------------------------------------

// A walk over the syntax tree that passes each node its chain of parents,
// [parent, key under the parent, the parent's chain]. Other passes of the
// build hang their own references on nodes, so only a node's own syntax is
// followed and no node is entered twice.
const SKIP = new Set(['loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'parent'])
const walk = (root, f) => {
  const seen = new Set()
  const go = (n, up) => {
    if (seen.has(n)) return
    seen.add(n)
    f(n, up)
    for (const k of Object.keys(n)) {
      if (SKIP.has(k) || k[0] === '_') continue
      const v = n[k]
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') go(c, [n, k, up]) } else if (v && typeof v.type === 'string') go(v, [n, k, up])
    }
  }
  if (root && typeof root.type === 'string') go(root, null)
}
// An identifier that stands for a value or a type, not a property name.
const isName = (n, up) => {
  if (!up) return true
  const p = up[0]; const k = up[1]
  if ((p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && k === 'property' && !p.computed) return false
  if ((p.type === 'ObjectProperty' || p.type === 'ObjectMethod' || p.type === 'ClassProperty' || p.type === 'ClassMethod') && k === 'key' && !p.computed) return false
  if (p.type === 'TSQualifiedName' && k === 'right') return false
  if (p.type === 'JSXAttribute' || p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return false
  return true
}

// The imports and constants a zodResolver rewrite reads: zod under one local
// name (`import { z }`, `import * as z` or `import z`, alone in its
// statement), zodResolver by name, and the file's top-level `const x = ...`
// statements of one declarator that are not exported.
export function readZodFile (ast) {
  let zod = null; let resolver = null
  const consts = new Map()
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type') {
      if (stmt.source.value === ZOD_RESOLVERS) {
        for (const sp of stmt.specifiers) if (sp.type === 'ImportSpecifier' && sp.importKind !== 'type' && (sp.imported.name || sp.imported.value) === 'zodResolver') resolver = { stmt, local: sp.local.name }
      } else if ((stmt.source.value === 'zod' || stmt.source.value === 'zod/v4') && stmt.specifiers.length === 1) {
        const sp = stmt.specifiers[0]
        const kind = sp.type === 'ImportNamespaceSpecifier' ? 'namespace' : sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.importKind !== 'type' && (sp.imported.name || sp.imported.value) === 'z' ? 'named' : null
        if (kind) zod = { stmt, local: sp.local.name, kind, source: stmt.source.value }
      }
    } else if (stmt.type === 'VariableDeclaration' && stmt.kind === 'const' && stmt.declarations.length === 1 && stmt.declarations[0].id.type === 'Identifier' && stmt.declarations[0].init) {
      consts.set(stmt.declarations[0].id.name, { stmt, init: stmt.declarations[0].init })
    }
  }
  return zod && resolver ? { zod, resolver, consts } : null
}

// The source that builds the schema `name` stands for, as the body of a
// function of zod's local name, with the constants it is made of before it;
// null where it names anything else (a value from outside, a function, a
// TypeScript expression): then it cannot be built outside the file.
export function schemaSource (name, info, code) {
  const order = []; const seen = new Set()
  const visit = (nm) => {
    if (seen.has(nm)) return true
    seen.add(nm)
    const c = info.consts.get(nm)
    if (!c) return false
    let ok = true
    walk(c.init, (n, up) => {
      if (!ok) return
      if (n.type.startsWith('TS') || n.type.startsWith('JSX') || /Function|Class|Await|Yield|Assignment|Update|New|This|Import|TaggedTemplate|Sequence/.test(n.type)) { ok = false; return }
      if (n.type === 'Identifier' && isName(n, up) && n.name !== info.zod.local && n.name !== 'undefined') { if (!info.consts.has(n.name) || !visit(n.name)) ok = false }
    })
    if (ok) order.push(nm)
    return ok
  }
  if (!visit(name)) return null
  return { names: order, text: order.map((nm) => `const ${nm} = ${code.slice(info.consts.get(nm).init.start, info.consts.get(nm).init.end)};\n`).join('') + `return ${name};` }
}

// Where the file still uses `names` once `removed` statements and `replaced`
// calls are gone: as values (which keeps them needed) and as types.
export function usesOf (ast, names, removed, replaced) {
  const out = new Map([...names].map((n) => [n, { values: 0, types: 0 }]))
  walk(ast.program, (n, up) => {
    if (n.type !== 'Identifier' || !out.has(n.name) || !isName(n, up)) return
    let type = false
    for (let a = up; a; a = a[2]) {
      const p = a[0]
      if (removed.has(p) || replaced.has(p)) return
      if (p.type === 'ImportDeclaration') return
      if (p.type.startsWith('TS')) type = true
    }
    if (up && up[0].type === 'VariableDeclarator' && up[1] === 'id') return
    const u = out.get(n.name); if (type) u.types++; else u.values++
  })
  return out
}
