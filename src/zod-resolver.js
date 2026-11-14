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
// formats zod checks with a pattern, as a check or as the schema itself; trim,
// toLowerCase and toUpperCase before the checks or after them), numbers (int, min, max, gt, lt,
// positive and the like), booleans, enums, literals, optional fields and
// nested objects, arrays of these, and refine where its function reads only
// its argument. Refused: unions, nullable, url, a refine that reads more, transform,
// default, coerce, a rewrite between two checks, strict and passthrough
// objects, zod 3.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { closesOver } from './zod.js'

export const ZOD_RESOLVERS = '@hookform/resolvers/zod'
const RT_TEXT = fs.readFileSync(new URL('./zod-resolver-rt.js', import.meta.url), 'utf8')
const bare = (text) => text.replace(/^\/\/[^\n]*\n/gm, '')
export const ZOD_RUNTIME = bare(RT_TEXT)
// Without the part that rewrites strings, for a file none of whose forms has
// a trim or a case rewrite: the rest only reaches it through a plan that
// says so (plan.rewrites).
const without = (text, part) => text.replace(new RegExp(`//<${part}>\\n[\\s\\S]*?//</${part}>\\n`), '')
// The run-time text for a file: the part that rewrites strings and the part
// that runs refine functions only where a plan of the file needs them. The
// rest reaches them only through a plan that says so.
export const zodRuntimeFor = (rewrites, refines) => bare(without(without(RT_TEXT, rewrites ? '-' : 'rewrites'), refines ? '-' : 'refines'))
export const ZOD_RUNTIME_PLAIN = zodRuntimeFor(false, false)
export const ZOD_RUNTIME_IMPORTS = "import { toNestErrors as __ataZNest, validateFieldsNatively as __ataZNative } from '@hookform/resolvers';\nimport { appendErrors as __ataZAppend } from 'react-hook-form';\n"
// The same text as functions of this process: selfCheck uses the issue list
// and the returned data, and a test builds the whole resolver from it with
// the real toNestErrors, validateFieldsNatively and appendErrors.
export const zodRuntime = (nest, native, append) => new Function('__ataZNest', '__ataZNative', '__ataZAppend', ZOD_RUNTIME + '\nreturn { run: __ataZRun, resolver: __ataZodResolver }')(nest, native, append)
const RT = zodRuntime(null, null, null)

const MAX_SAFE = Number.MAX_SAFE_INTEGER
// What a refusal says for the kinds of schema that are not carried.
const KINDS = {
  union: 'a union is not carried yet', nullable: 'nullable() is not carried yet', default: 'default() is not carried yet',
  pipe: 'a transform or a pipe is not carried', transform: 'a transform is not carried', date: 'a date is not carried',
  any: 'any() is not carried', unknown: 'unknown() is not carried', record: 'a record is not carried', tuple: 'a tuple is not carried', lazy: 'lazy() is not carried',
  intersection: 'an intersection is not carried', catch: 'catch() is not carried', readonly: 'readonly() is not carried', file: 'a file is not carried', bigint: 'a bigint is not carried',
  null: 'null() is not carried', undefined: 'undefined() is not carried', nonoptional: 'nonoptional() is not carried', template_literal: 'a template literal is not carried',
}
export class ZodRefused extends Error { get name () { return 'ZodRefused' } }
const no = (why) => { throw new ZodRefused(why) }
const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1')

const issuesOf = (node, v) => { const r = node.safeParse(v); return r.success ? [] : r.error.issues }
const one = (node, v, pick, what) => { const hit = issuesOf(node, v).filter((i) => i.path.length === 0 && pick(i)); if (hit.length !== 1) no(hit.length ? 'two checks of one kind on this field, which the build cannot tell apart' : `zod did not report the ${what} check the build asked about`); return [hit[0].code, hit[0].message] }

// The type rule of a leaf: a custom message is one zod gives whatever came.
const DEFAULT_TYPE = /^Invalid input: expected (\w+), received /
function typeEntry (node, expected, probes) {
  const msgs = probes.map((p) => { const i = issuesOf(node, p).filter((x) => x.code === 'invalid_type' && x.expected === expected); if (i.length !== 1) no(`zod did not report a wrong type for a ${expected} the way the build expects`); return i[0].message })
  if (msgs.every((m) => m === msgs[0]) && !DEFAULT_TYPE.test(msgs[0])) return { m: msgs[0] }
  if (!msgs.every((m) => { const d = DEFAULT_TYPE.exec(m); return d && d[1] === expected })) no('the wrong-type message is a function of the value, which the build cannot carry')
  return { x: expected }
}

export function planZod (schema) {
  const table = {}      // schemaPath -> [rank, code, message] | { type entries }
  const paths = {}      // instancePath -> { o: order, u: [code, message] when undefined }
  let order = 0
  let rewrites = false
  // refine(): [pattern, rank, function, message, path, stops], in the order
  // zod runs them (a node's children before the node), and the functions.
  const refines = []; const fns = []
  const refine = (d, rank, ip, owner) => {
    if (typeof d.fn !== 'function' || d.when) no('a check written with check() or superRefine() is not carried')
    if (d.fn.constructor && d.fn.constructor.name !== 'Function') no('an async refine is not carried')
    const outside = closesOver(String(d.fn))
    if (outside.length) no(`a refine that reads ${outside.map((n) => '`' + n + '`').join(', ')} from outside its own argument is not carried`)
    // Its message: its own, or the one the schema it stands on was given
    // (z.string({ error })), which zod uses for a check that has none.
    let message = null
    const error = d.error || owner.error
    if (error) {
      const said = [undefined, 'x'].map((input) => { const m = error({ code: 'custom', input, path: [], inst: null }); return typeof m === 'string' ? m : m && typeof m.message === 'string' ? m.message : undefined })
      if (said[0] === undefined || said[0] !== said[1]) no('a refine whose message is a function of the value is not carried')
      message = said[0]
    }
    if (!Array.isArray(d.path || []) || (d.path || []).some((x) => typeof x !== 'string' && typeof x !== 'number')) no('a refine with a path that is not names and indexes is not carried')
    refines.push([ip, rank, fns.push(d.fn) - 1, message, (d.path || []).map((x) => '/' + esc(String(x))).join(''), d.abort ? 1 : 0])
  }
  // A refusal names the field it is about, as the form names it.
  const walk = (node, sp, ip) => {
    try { return walkNode(node, sp, ip) } catch (e) {
      if (e instanceof ZodRefused && e.field === undefined) { e.field = ip; e.message = `${ip ? ip.slice(1).split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~')).join('.') : 'the schema'}: ${e.message}` }
      throw e
    }
  }
  const walkNode = (node, sp, ip) => {
    let def = node._zod.def
    let optional = false
    if (def.type === 'optional') { if ((def.checks || []).length) no('a check written after optional() is not carried'); optional = true; node = def.innerType; def = node._zod.def }
    const here = paths[ip] = { o: order++ }
    if (!optional) { const u = issuesOf(node, undefined); if (u.length !== 1) no(u.length === 0 ? 'a field that takes a missing value without being optional (any, unknown, a default) is not carried' : 'zod reports more than one thing for a missing value here'); here.u = [u[0].code, u[0].message] }
    else here.q = 1
    const out = {}
    const dup = new Set()
    const put = (kw, value, entry) => {
      if (dup.has(kw)) { (out.allOf || (out.allOf = [])).push({ [kw]: value }); table[`${sp}/allOf/${out.allOf.length - 1}/${kw}`] = entry } else { dup.add(kw); out[kw] = value; table[`${sp}/${kw}`] = entry }
    }
    const checks = def.checks || []
    if (def.type === 'string') {
      const len = []
      if (def.coerce) no('coerce on a string is not carried')
      out.type = 'string'; table[`${sp}/type`] = { t: typeEntry(node, 'string', [null, 1, true, {}]), l: len }
      // zod runs a length check on anything that has a length, a string or
      // not, and words the default message by what it was given.
      const origins = (n, pick, what) => [one(node, new Array(n).fill(0), pick, what), one(node, { length: n }, pick, what)].map((x) => x[1])
      // A string zod rewrites: the rewrites written before every check are
      // made before the check runs, those after every check only on what is
      // handed back. One between two checks is refused.
      const OPS = [/=>\s*input\.trim\(\)$/, /=>\s*input\.toLowerCase\(\)$/, /=>\s*input\.toUpperCase\(\)$/]
      const opOf = (d) => d.check === 'overwrite' && typeof d.tx === 'function' ? OPS.findIndex((re) => re.test(String(d.tx).trim())) : -1
      const kinds = checks.map((c) => c._zod.def.check === 'overwrite' ? (opOf(c._zod.def) === -1 ? no('a rewrite other than trim, toLowerCase and toUpperCase') : 'w') : 'c')
      // A format that is the schema itself (z.email()) is checked before
      // every entry of the list, so it counts as a check at its head.
      const head = def.check === 'string_format'
      const firstCheck = head ? -1 : kinds.indexOf('c'); const lastCheck = kinds.lastIndexOf('c')
      const any = head || lastCheck !== -1
      kinds.forEach((k, i) => { if (k === 'w' && any && i > firstCheck && i < lastCheck) no('a rewrite between two checks') })
      const pre = []; const post = []
      checks.forEach((c, i) => { if (kinds[i] === 'w') (!any || (!head && i < firstCheck) ? pre : post).push(opOf(c._zod.def)) })
      if (pre.length) { here.w = pre; paths[''].p = 1; rewrites = true }
      if (post.length) { here.x = post; rewrites = true }
      // z.email() and the like: the format is the schema itself and is
      // checked before its checks.
      if (def.check === 'string_format') {
        if (!(def.pattern instanceof RegExp) || (def.pattern.flags !== '' && def.pattern.flags !== 'u')) no(`${def.format}() is not carried (zod does not check it with a pattern)`)
        const bad = ['', ' ', '\u0000', 'x', '@', '0'].find((v) => !def.pattern.test(v))
        if (bad === undefined) no('a pattern no probe breaks')
        put('pattern', def.pattern.source, [-0.5, ...one(node, bad, (i) => i.code === 'invalid_format' && i.format === def.format, 'format')])
      }
      checks.forEach((c, rank) => {
        const d = c._zod.def
        if (d.check === 'overwrite') return
        if (d.check === 'min_length' && d.minimum >= 1) len.push([0, d.minimum, rank, 'too_small', ...origins(d.minimum - 1, (i) => i.code === 'too_small' && i.minimum === d.minimum, 'min')])
        if (d.check === 'max_length') len.push([1, d.maximum, rank, 'too_big', ...origins(d.maximum + 1, (i) => i.code === 'too_big' && i.maximum === d.maximum, 'max')])
        if (d.check === 'length_equals') { if (d.length >= 1) len.push([0, d.length, rank, 'too_small', ...origins(d.length - 1, (i) => i.code === 'too_small' && i.exact === true, 'length')]); len.push([1, d.length, rank, 'too_big', ...origins(d.length + 1, (i) => i.code === 'too_big' && i.exact === true, 'length')]) }
        if (d.check === 'custom') { refine(d, rank, ip, def); return }
        if (d.check === 'min_length') { if (d.minimum < 1) return; put('minLength', d.minimum, [rank, ...one(node, 'a'.repeat(d.minimum - 1), (i) => i.code === 'too_small' && i.minimum === d.minimum, 'min')]) }
        else if (d.check === 'max_length') { if (d.maximum > 100000) no('a very long maximum'); put('maxLength', d.maximum, [rank, ...one(node, 'a'.repeat(d.maximum + 1), (i) => i.code === 'too_big' && i.maximum === d.maximum, 'max')]) }
        else if (d.check === 'length_equals') {
          if (d.length > 100000) no('a very long length')
          if (d.length >= 1) put('minLength', d.length, [rank, ...one(node, 'a'.repeat(d.length - 1), (i) => i.code === 'too_small' && i.exact === true, 'length')])
          put('maxLength', d.length, [rank, ...one(node, 'a'.repeat(d.length + 1), (i) => i.code === 'too_big' && i.exact === true, 'length')])
        } else if (d.check === 'string_format' && d.pattern instanceof RegExp && (d.pattern.flags === '' || d.pattern.flags === 'u')) {
          const bad = ['', ' ', '\u0000', 'x', '@', '0', 'A', '~', 'a b'].find((s) => !d.pattern.test(s))
          if (bad === undefined) no('a pattern no probe breaks')
          put('pattern', d.pattern.source, [rank, ...one(node, bad, (i) => i.code === 'invalid_format' && i.format === d.format && (i.pattern === undefined || i.pattern === String(d.pattern)), 'format')])
        } else no(d.check === 'string_format' ? `${d.format}() is not carried (zod does not check it with a pattern)` : d.check === 'custom' ? 'refine() is not carried' : `the string check ${d.check} is not carried`)
      })
    } else if (def.type === 'number') {
      const fmt = checks.filter((c) => c._zod.def.check === 'number_format')
      if (fmt.length > 1 || (fmt.length === 1 && fmt[0]._zod.def.format !== 'safeint')) no('a number format other than int')
      out.type = fmt.length ? 'integer' : 'number'
      // z.coerce.number(): zod takes Number(value) first, of whatever came,
      // so the only wrong type left is NaN. The same is done to a copy of the
      // document before the check.
      if (def.coerce) { here.w = [3]; paths[''].p = 1; rewrites = true }
      const t = { t: typeEntry(node, 'number', def.coerce ? ['a', {}, 'x y'] : [null, 'a', true, {}]) }
      if (fmt.length) t.i = [checks.indexOf(fmt[0]), ...one(node, 0.5, (i) => i.code === 'invalid_type' && i.expected === 'int', 'int')]
      table[`${sp}/type`] = t
      checks.forEach((c, rank) => {
        const d = c._zod.def
        if (d.check === 'custom') { refine(d, rank, ip, def); return }
        if (d.check === 'number_format') {
          put('maximum', MAX_SAFE, [rank, ...one(node, 2 ** 60, (i) => i.code === 'too_big' && i.maximum === MAX_SAFE, 'int upper')])
          put('minimum', -MAX_SAFE, [rank, ...one(node, -(2 ** 60), (i) => i.code === 'too_small' && i.minimum === -MAX_SAFE, 'int lower')])
        } else if (d.check === 'greater_than' && typeof d.value === 'number') put(d.inclusive ? 'minimum' : 'exclusiveMinimum', d.value, [rank, ...one(node, d.value - 1, (i) => i.code === 'too_small' && i.minimum === d.value, 'min')])
        else if (d.check === 'less_than' && typeof d.value === 'number') put(d.inclusive ? 'maximum' : 'exclusiveMaximum', d.value, [rank, ...one(node, d.value + 1, (i) => i.code === 'too_big' && i.maximum === d.value, 'max')])
        else no(d.check === 'custom' ? 'refine() is not carried' : `the number check ${d.check} is not carried`)
      })
    } else if (def.type === 'boolean') {
      if (checks.length) no('a check on a boolean')
      if (def.coerce) no('coerce on a boolean is not carried')
      out.type = 'boolean'; table[`${sp}/type`] = { t: typeEntry(node, 'boolean', [null, 'a', 1, {}]) }
    } else if (def.type === 'enum' || def.type === 'literal') {
      if (checks.length) no('a check on an enum')
      const values = def.type === 'enum' ? Object.values(def.entries) : def.values
      if (!values.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean')) no('an enum value that is not a string, number or boolean')
      out.enum = values
      const probes = [null, '\u0000 not a member', -0.123456789, {}].map((p) => issuesOf(node, p))
      if (!probes.every((i) => i.length === 1 && i[0].code === probes[0][0].code && i[0].message === probes[0][0].message)) no('an enum message that depends on the value')
      table[`${sp}/enum`] = [0, probes[0][0].code, probes[0][0].message, 0, 1]
    } else if (def.type === 'array') {
      const el = def.element
      if (el._zod.def.type === 'optional') no('an array of optional items is not carried')
      out.type = 'array'; here.a = 1
      const len = []
      table[`${sp}/type`] = { t: typeEntry(node, 'array', [null, 1, true, {}]), l: len, s: 1 }
      // A length check also runs on a string or anything else with a length.
      const origins = (n, pick, what) => [one(node, 'a'.repeat(n), pick, what), one(node, { length: n }, pick, what)].map((x) => x[1])
      const filled = (n) => new Array(n).fill(null)
      checks.forEach((c, rank) => {
        const d = c._zod.def
        if (d.check === 'custom') return
        const n = d.check === 'min_length' ? d.minimum : d.check === 'max_length' ? d.maximum : d.check === 'length_equals' ? d.length : no(`the array check ${d.check} is not carried`)
        if (n > 10000) no('a very long array bound')
        const small = (i) => i.code === 'too_small' && (d.check === 'length_equals' ? i.exact === true : i.minimum === n)
        const big = (i) => i.code === 'too_big' && (d.check === 'length_equals' ? i.exact === true : i.maximum === n)
        if (d.check !== 'max_length' && n >= 1) { len.push([0, n, rank, 'too_small', ...origins(n - 1, small, 'min')]); put('minItems', n, [rank, ...one(node, filled(n - 1), small, 'min'), 1]) }
        // Longer than a maximum: zod reports that and does not read the items.
        if (d.check !== 'min_length') { len.push([1, n, rank, 'too_big', ...origins(n + 1, big, 'max')]); put('maxItems', n, [rank, ...one(node, filled(n + 1), big, 'max'), 2]) }
      })
      if (out.allOf) no('two length checks of one kind on an array')
      out.items = walk(el, `${sp}/items`, `${ip}/*`)
      checks.forEach((c, rank) => { if (c._zod.def.check === 'custom') refine(c._zod.def, rank, ip, def) })
    } else if (def.type === 'object') {
      if (def.catchall) no('a strict, loose or catchall object is not carried')
      if (checks.some((c) => c._zod.def.check !== 'custom')) no('a check on an object other than refine() is not carried')
      out.type = 'object'; table[`${sp}/type`] = { t: typeEntry(node, 'object', [null, 'a', 1, true]) }
      out.properties = {}; const required = []; here.k = Object.keys(def.shape)
      for (const k of here.k) {
        if (k === '__proto__') no('a __proto__ key')
        const child = def.shape[k]
        if (child._zod.def.type !== 'optional') required.push(k)
        out.properties[k] = walk(child, `${sp}/properties/${esc(k)}`, `${ip}/${esc(k)}`)
      }
      if (required.length) out.required = required
      checks.forEach((c, rank) => refine(c._zod.def, rank, ip, def))
    } else no(KINDS[def.type] || `${def.type} is not carried`)
    return out
  }
  if (schema._zod.def.type !== 'object') no(schema._zod.def.type === 'pipe' ? 'the schema is a transform or a pipe, which is not carried' : 'the schema is not an object')
  const json = walk(schema, '#', '')
  return { json, table, paths, rewrites, refines: refines.length ? refines : null, fns }
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
const POOL = [undefined, null, '', ' ', 'a', 'ab', 'abc', '@ab', 'A!1', 'Ab!1x', 'abc123', 'user_name', 'Abcdef1!', 'Passw0rd!', '123456', '1234567890', '42', ' 7 ', '1e3', '2024-01-01', 'https://example.com', '+15555550100', '  ab ', ' A@B.CO ', 'ABC', 'Stra\u00dfe', 'abcdefghijklmnopqrstuvwxyz0123456789', 'a@b.co', 'A1b2c3d4', '12345', '123e4567-e89b-42d3-a456-426614174000', 0, 1, -1, 0.5, 17, 18, 100, 1e9, 2 ** 60, NaN, Infinity, true, false, [], ['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'], {}, { length: 1 }, { length: 99 }, new Date(0)]
const show = (x) => JSON.stringify(x, (k, v) => v === undefined ? '\u0000undefined' : typeof v === 'number' && !Number.isFinite(v) ? '\u0000' + String(v) : v)

// Whether the plan answers as the schema does: zod's issues (path, code,
// message, in order) and the data it returns, on a document that passes, on
// that document with each field in turn missing and holding each value of
// the pool, and on documents with several fields wrong. `validate` is the
// check compiled from plan.json with plain errors.
export function selfCheck (schema, plan, validate) {
  const leaves = []; const arrays = []
  const copyOf = (d) => { if (Array.isArray(d)) return d.map(copyOf); if (d === null || typeof d !== 'object' || Object.getPrototypeOf(d) !== Object.prototype) return d; const o = {}; for (const k of Object.keys(d)) o[k] = copyOf(d[k]); return o }
  const good = (node, ip) => {
    let def = node._zod.def; let optional = false
    if (def.type === 'optional') { optional = true; node = def.innerType; def = node._zod.def }
    if (def.type === 'object') { const out = {}; for (const [k, child] of Object.entries(def.shape)) out[k] = good(child, ip.concat(k)); return out }
    if (def.type === 'array') {
      // Two items where the bounds allow, the first of them varied below.
      const bound = (kind) => { const c = (def.checks || []).map((x) => x._zod.def).find((d) => d.check === kind || d.check === 'length_equals'); return c === undefined ? undefined : c.check === 'length_equals' ? c.length : kind === 'min_length' ? c.minimum : c.maximum }
      const min = bound('min_length') || 0; const max = bound('max_length')
      const n = Math.max(min, Math.min(2, max === undefined ? 2 : max))
      if (n > 50) throw new ZodRefused('an array that needs many items')
      const before = [leaves.length, arrays.length]
      const item = good(def.element, ip.concat(0))
      // An array that has to be empty has no first item to vary.
      if (n === 0) { leaves.length = before[0]; arrays.length = before[1] }
      arrays.push({ ip, item, n, min, max })
      return Array.from({ length: n }, () => copyOf(item))
    }
    const candidates = def.type === 'enum' ? Object.values(def.entries) : def.type === 'literal' ? def.values : POOL
    const ok = candidates.find((c) => c !== undefined && node.safeParse(c).success)
    if (ok === undefined && !optional) throw new ZodRefused(`${ip.join('.')}: the build has no sample value that passes this field's rules, so it could not hold the form to zod`)
    leaves.push(ip)
    return ok
  }
  const base = good(schema, [])
  const copy = copyOf
  const set = (d, ip, v, drop) => { const o = copy(d); let at = o; for (let i = 0; i < ip.length - 1; i++) at = at[ip[i]]; if (drop) delete at[ip[ip.length - 1]]; else at[ip[ip.length - 1]] = v; return o }
  const docs = [base, {}, { ...copy(base), ['\u0000extra']: 1 }]
  for (const ip of leaves) { docs.push(set(base, ip, undefined, true)); for (const v of POOL) docs.push(set(base, ip, v, false)) }
  // An array empty, one short of its minimum, one over its maximum, long, and
  // with an item that is not there.
  for (const { ip, item, n, min, max } of arrays) {
    if (ip.some((x) => typeof x === 'number')) continue
    const of = (k) => Array.from({ length: k }, () => copyOf(item))
    for (const k of new Set([0, 1, Math.max(0, min - 1), min, n + 1, max === undefined ? 5 : max + 1, max === undefined ? 5 : max])) if (k <= 200) docs.push(set(base, ip, of(k), false))
    if (n > 0) { const holed = of(n); holed[0] = undefined; docs.push(set(base, ip, holed, false)) }
    for (const v of POOL) docs.push(set(base, ip, v, false))
  }
  // Parents of leaves, wrong as a whole.
  const parents = new Set(leaves.filter((ip) => ip.length > 1).map((ip) => JSON.stringify(ip.slice(0, -1))))
  for (const p of parents) for (const v of [undefined, null, 'a', 1, [], {}]) docs.push(set(base, JSON.parse(p), v, false))
  // Several fields wrong at once, by a fixed sequence.
  let seed = 7; const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n }
  for (let i = 0; i < 60 && leaves.length > 1; i++) { let d = base; for (const ip of leaves) if (next(3) === 0) d = set(d, ip, POOL[next(POOL.length)], next(5) === 0); docs.push(d) }
  for (const d of docs) {
    const want = schema.safeParse(copy(d))
    const got = RT.run(validate, plan.table, plan.paths, copy(d), plan.refines, plan.fns)
    if (want.success !== (got.issues === undefined)) return `verdict on ${show(d)}`
    if (want.success) { if (show(want.data) !== show(got.data)) return `data on ${show(d)}`; continue }
    const mine = got.issues
    const theirs = want.error.issues.map((i) => ['' + i.path.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join(''), i.code, i.message])
    if (show(mine) !== show(theirs)) return `issues on ${show(d)}: zod ${show(theirs)}, the build ${show(mine)}`
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
    if (f(n, up) === false) return
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

// What a zodResolver rewrite reads of a file: zod under one local name
// (`import { z }`, `import * as z` or `import z`, alone in its statement),
// zodResolver by name, the top-level `const x = ...` statements of one
// declarator, and the names the file exports them under.
export function readZodFile (ast, needResolver = true) {
  let zod = null; let resolver = null
  const consts = new Map(); const exports = new Map()
  const one = (stmt, decl, exported) => {
    if (decl.type !== 'VariableDeclaration' || decl.kind !== 'const' || decl.declarations.length !== 1 || decl.declarations[0].id.type !== 'Identifier' || !decl.declarations[0].init) return
    const name = decl.declarations[0].id.name
    consts.set(name, { stmt, init: decl.declarations[0].init, exported })
    if (exported) exports.set(name, name)
  }
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type') {
      if (stmt.source.value === ZOD_RESOLVERS) {
        for (const sp of stmt.specifiers) if (sp.type === 'ImportSpecifier' && sp.importKind !== 'type' && (sp.imported.name || sp.imported.value) === 'zodResolver') resolver = { stmt, local: sp.local.name }
      } else if ((stmt.source.value === 'zod' || stmt.source.value === 'zod/v4') && stmt.specifiers.length === 1) {
        const sp = stmt.specifiers[0]
        const kind = sp.type === 'ImportNamespaceSpecifier' ? 'namespace' : sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.importKind !== 'type' && (sp.imported.name || sp.imported.value) === 'z' ? 'named' : null
        if (kind) zod = { stmt, local: sp.local.name, kind, source: stmt.source.value }
      }
    } else if (stmt.type === 'VariableDeclaration') one(stmt, stmt, false)
    else if (stmt.type === 'ExportNamedDeclaration' && stmt.exportKind !== 'type') {
      if (stmt.declaration) one(stmt, stmt.declaration, true)
      else if (!stmt.source) for (const sp of stmt.specifiers) if (sp.type === 'ExportSpecifier' && sp.exportKind !== 'type' && sp.local.type === 'Identifier') { exports.set(sp.exported.name || sp.exported.value, sp.local.name); const c = consts.get(sp.local.name); if (c) c.exported = true }
    }
  }
  // `export { x }` written before the constant it names.
  for (const local of exports.values()) { const c = consts.get(local); if (c) c.exported = true }
  return resolver || !needResolver ? { zod, resolver, consts, exports } : null
}

// A module a form imports its schema from, read as text and never run: its
// zod import, constants and exports, with the source they are cut from.
export function readZodModule (file, parse) {
  let code
  try { if (fs.statSync(file).size > 1 << 18) return null; code = fs.readFileSync(file, 'utf8') } catch { return null }
  if (!code.includes('zod')) return null
  let ast
  try { ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: false }) } catch { return null }
  const info = readZodFile(ast, false)
  return info.zod ? { ...info, code } : null
}

// The source that builds the schema `name` stands for, as the body of a
// function of zod's local name, with the constants it is made of before it;
// null where it names anything else (a value from outside, a function, a
// TypeScript expression): then it cannot be built outside the file.
export function schemaSource (name, info, code, exportedToo = false, out = {}) {
  const order = []; const seen = new Set()
  const fail = (why) => { if (out.why === undefined) out.why = why; return false }
  const readable = (node) => {
    let ok = true
    walk(node, (n, up) => {
      if (!ok) return
      // A function is read where it is what refine() is given and reads
      // nothing but its own argument; its body is not walked.
      if (/^(?:Arrow)?FunctionExpression$/.test(n.type) && !n.async && !n.generator && up && up[0].type === 'CallExpression' && up[1] === 'arguments' && up[0].arguments[0] === n && up[0].callee.type === 'MemberExpression' && !up[0].callee.computed && up[0].callee.property.name === 'refine') {
        const outside = closesOver(code.slice(n.start, n.end))
        if (outside.length) ok = fail(`a refine reads ${outside.map((x) => '`' + x + '`').join(', ')} from outside its own argument, which the build does not carry`)
        return false
      }
      if (n.type.startsWith('TS') || n.type.startsWith('JSX') || /Function|Class|Await|Yield|Assignment|Update|New|This|Import|TaggedTemplate|Sequence/.test(n.type)) { ok = fail(/Function/.test(n.type) ? 'the schema has a function in it (a refine, a transform or a message function), which the build does not carry' : n.type.startsWith('TS') ? 'the schema has TypeScript syntax in it (a cast or a type argument)' : `the schema has a ${n.type} in it, which the build does not read`); return }
      // Nothing but zod's own methods by name: no computed member, and none
      // of the names that reach a function constructor.
      if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && (n.computed || /^(?:constructor|prototype|__proto__|call|apply|bind)$/.test(n.property.name))) { ok = fail('the schema reads a member the build does not follow'); return }
      if (n.type === 'Identifier' && isName(n, up) && n.name !== info.zod.local && n.name !== 'undefined') { if (!info.consts.has(n.name)) ok = fail(`the schema uses \`${n.name}\`, which is not zod or a constant written at the top of the file`); else if (!visit(n.name)) ok = false }
    })
    return ok
  }
  const visit = (nm) => {
    if (seen.has(nm)) return true
    seen.add(nm)
    const c = info.consts.get(nm)
    // In the file of the call an exported constant has readers the build
    // does not see, so it cannot be taken out and is not read.
    if (!c) return fail(`\`${nm}\` is not a constant written at the top of the file`)
    if (c.exported && !exportedToo) return fail(`\`${nm}\` is exported, so other files may read it and it cannot leave this one`)
    if (!readable(c.init)) return false
    order.push(nm)
    return true
  }
  // A name, or the expression written in the call itself.
  if (typeof name === 'string') { if (!visit(name)) return null } else if (!readable(name)) return null
  const body = order.map((nm) => `const ${nm} = ${code.slice(info.consts.get(nm).init.start, info.consts.get(nm).init.end)};\n`).join('')
  return { names: order, text: body + (typeof name === 'string' ? `return ${name};` : `return (${code.slice(name.start, name.end)});`) }
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
