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
// its argument, and strict objects; nullable(), nullish() and optional()
// around any of them in any order, default() with a constant the field
// itself passes, any() and unknown(), loose objects. Refused: unions, a
// refine that reads more, transform, catch, a default the field would
// refuse, coerce on anything but a number, a rewrite between two checks, an
// object with a catchall of its own, zod 3.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { closesOver } from './zod.js'

export const ZOD_RESOLVERS = '@hookform/resolvers/zod'
const RT_TEXT = fs.readFileSync(new URL('./zod-resolver-rt.js', import.meta.url), 'utf8')
const bare = (text) => text.replace(/^\/\/[^\n]*\n/gm, '')
export const ZOD_RUNTIME = bare(RT_TEXT)
// A value a default can be on the page: text, a number, a boolean, null, or
// an array or a plain object of those (one level, which is as deep as zod
// copies a default before it hands it back).
const flatValue = (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
const constant = (v) => flatValue(v) || (Array.isArray(v) ? v.every(flatValue) : typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).every((k) => k !== '__proto__' && flatValue(v[k])))
// Without the part that rewrites strings, for a file none of whose forms has
// a trim or a case rewrite: the rest only reaches it through a plan that
// says so (plan.rewrites).
const without = (text, part) => text.replace(new RegExp(`//<${part}>\\n[\\s\\S]*?//</${part}>\\n`, 'g'), '')
// The run-time text for a file: the part that rewrites strings and the part
// that runs refine functions only where a plan of the file needs them. The
// rest reaches them only through a plan that says so.
// `kinds`: the parts only a plan with that kind of field reaches, { nulls,
// defaults, missing, loose }: a nullable field, a default, a field of any()
// or unknown() whose key has to be there, a loose object.
export const zodRuntimeFor = (rewrites, refines, strict, resolver = true, parse = false, flat = false, kinds = {}) => bare([['rewrites', rewrites], ['refines', refines], ['strict', strict], ['resolver', resolver], ['parse', parse], ['flat', flat], ['nulls', !!kinds.nulls], ['defaults', !!kinds.defaults], ['missing', !!kinds.missing], ['loose', !!kinds.loose]].reduce((text, [part, kept]) => kept ? text : without(text, part), RT_TEXT))
export const ZOD_RUNTIME_PLAIN = zodRuntimeFor(false, false, false)
export const ZOD_RUNTIME_IMPORTS = "import { toNestErrors as __ataZNest, validateFieldsNatively as __ataZNative } from '@hookform/resolvers';\nimport { appendErrors as __ataZAppend } from 'react-hook-form';\n"
// The same text as functions of this process: selfCheck uses the issue list
// and the returned data, and a test builds the whole resolver from it with
// the real toNestErrors, validateFieldsNatively and appendErrors.
export const zodRuntime = (nest, native, append) => new Function('__ataZNest', '__ataZNative', '__ataZAppend', ZOD_RUNTIME + '\nreturn { run: __ataZRun, resolver: __ataZodResolver, schema: __ataZSchema, flat: __ataZFlat }')(nest, native, append)
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
  const kinds = {}
  // refine(): [pattern, rank, function, message, path, stops], in the order
  // zod runs them (a node's children before the node), and the functions.
  const refines = []; const fns = []
  // A refine whose path names an index: a resolver joins a path into one
  // name, where 0 and '0' are the same; an issue's path keeps them apart.
  let indexed = false
  // url(): zod trims the value and asks the platform's URL parser, the
  // parser the page will ask too; it is run on the page as a refine is, and
  // the value it hands back is the trimmed one.
  const URL_CHECK = (v) => { const t = v.trim(); try { if (typeof URL.canParse === 'function') return URL.canParse(t); new URL(t); return true } catch { return false } }
  const url = (d, rank, ip, here, last) => {
    if ('normalize' in d || 'hostname' in d || 'protocol' in d) no('url() with normalize, hostname or protocol is not carried')
    if (!last) no('a check written after url() is not carried (url() rewrites the value it passes)')
    const [code, message] = one(node0(ip), 'not a url', (i) => i.code === 'invalid_format' && i.format === 'url', 'url')
    refines.push([ip, rank, fns.push(URL_CHECK) - 1, message, '', d.abort ? 1 : 0, code])
    here.x = (here.x || []).concat(4); rewrites = true
  }
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
    if ((d.path || []).some((x) => typeof x === 'number')) indexed = true
    refines.push([ip, rank, fns.push(d.fn) - 1, message, (d.path || []).map((x) => '/' + esc(String(x))).join(''), d.abort ? 1 : 0])
  }
  // A refusal names the field it is about, as the form names it.
  const walk = (node, sp, ip) => {
    try { return walkNode(node, sp, ip) } catch (e) {
      if (e instanceof ZodRefused && e.field === undefined) { e.field = ip; e.message = `${ip ? ip.slice(1).split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~')).join('.') : 'the schema'}: ${e.message}` }
      throw e
    }
  }
  const nodes = new Map(); const node0 = (ip) => nodes.get(ip)
  const walkNode = (node, sp, ip) => {
    let def = node._zod.def
    // optional(), nullable() and default() around a field, in any order
    // (nullish() is the first two). What the whole takes for a missing value
    // and for null is asked of zod itself, on the field as it is written.
    const outer = node
    let optional = false; let nullable = false; let defaulted = false
    while (def.type === 'optional' || def.type === 'nullable' || def.type === 'default') {
      if ((def.checks || []).length) no(`a check written after ${def.type}() is not carried`)
      if (def.type === 'optional') optional = true
      else if (def.type === 'nullable') nullable = true
      else { if (defaulted) no('a default written on a default is not carried'); defaulted = true }
      node = def.innerType; def = node._zod.def
    }
    const here = paths[ip] = { o: order++ }
    nodes.set(ip, node)
    const missing = outer.safeParse(undefined)
    if (!missing.success) {
      if (optional || defaulted) no('zod refuses a missing value for a field written optional or with a default')
      const u = missing.error.issues; if (u.length !== 1) no('zod reports more than one thing for a missing value here'); here.u = [u[0].code, u[0].message]
    } else if (missing.data !== undefined) {
      // A default: what zod hands back for a missing value, without checking
      // it. The page writes it in before its check, so it has to be a value
      // the field itself passes unchanged, and one that can be written down.
      const d = missing.data
      if (!defaulted) no('a field that takes a missing value without being optional (any, unknown, a default) is not carried')
      if (!constant(d) || show(outer.safeParse(undefined).data) !== show(d)) no('a default that is not text, a number, a boolean, null, or a list or an object of those is not carried')
      const back = outer.safeParse(d)
      if (!back.success || show(back.data) !== show(d)) no('a default the field itself would refuse or rewrite is not carried')
      here.d = d; paths[''].p = 1; rewrites = true; kinds.defaults = true
    } else if (optional) here.q = 1
    // any() and unknown() take undefined; whether the key may also be absent
    // is asked of zod by the object that holds the field.
    else if (def.type === 'any' || def.type === 'unknown') { here.q = 1; here.y = 1 }
    else no('a field that takes a missing value without being optional (any, unknown, a default) is not carried')
    if (nullable) {
      const n = outer.safeParse(null)
      if (!n.success || n.data !== null) no('zod does not take null for a field written nullable')
      here.n = 1; kinds.nulls = true
    }
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
      const lastCheck0 = checks.length - 1
      if (def.check === 'string_format' && def.format === 'url' && !(def.pattern instanceof RegExp)) url(def, -0.5, ip, here, checks.length === 0)
      else if (def.check === 'string_format') {
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
        if (d.check === 'string_format' && d.format === 'url' && !(d.pattern instanceof RegExp)) { url(d, rank, ip, here, rank === lastCheck0); return }
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
      // z.int(): the format is the schema itself and is checked before its
      // checks, as z.email() is.
      const head = def.check === 'number_format'
      if (fmt.length + (head ? 1 : 0) > 1 || (fmt.length === 1 && fmt[0]._zod.def.format !== 'safeint') || (head && def.format !== 'safeint')) no('a number format other than int')
      out.type = fmt.length || head ? 'integer' : 'number'
      // z.coerce.number(): zod takes Number(value) first, of whatever came,
      // so the only wrong type left is NaN. The same is done to a copy of the
      // document before the check.
      if (def.coerce) { here.w = [3]; paths[''].p = 1; rewrites = true }
      const t = { t: typeEntry(node, 'number', def.coerce ? ['a', {}, 'x y'] : [null, 'a', true, {}]) }
      if (fmt.length || head) t.i = [head ? -0.5 : checks.indexOf(fmt[0]), ...one(node, 0.5, (i) => i.code === 'invalid_type' && i.expected === 'int', 'int')]
      table[`${sp}/type`] = t
      const safe = (rank) => {
        put('maximum', MAX_SAFE, [rank, ...one(node, 2 ** 60, (i) => i.code === 'too_big' && i.maximum === MAX_SAFE, 'int upper')])
        put('minimum', -MAX_SAFE, [rank, ...one(node, -(2 ** 60), (i) => i.code === 'too_small' && i.minimum === -MAX_SAFE, 'int lower')])
      }
      if (head) safe(-0.5)
      checks.forEach((c, rank) => {
        const d = c._zod.def
        if (d.check === 'custom') { refine(d, rank, ip, def); return }
        if (d.check === 'number_format') safe(rank)
        else if (d.check === 'greater_than' && typeof d.value === 'number') put(d.inclusive ? 'minimum' : 'exclusiveMinimum', d.value, [rank, ...one(node, d.value - 1, (i) => i.code === 'too_small' && i.minimum === d.value, 'min')])
        else if (d.check === 'less_than' && typeof d.value === 'number') put(d.inclusive ? 'maximum' : 'exclusiveMaximum', d.value, [rank, ...one(node, d.value + 1, (i) => i.code === 'too_big' && i.maximum === d.value, 'max')])
        else no(d.check === 'custom' ? 'refine() is not carried' : `the number check ${d.check} is not carried`)
      })
    } else if (def.type === 'boolean') {
      if (checks.length) no('a check on a boolean')
      if (def.coerce) no('coerce on a boolean is not carried')
      out.type = 'boolean'; table[`${sp}/type`] = { t: typeEntry(node, 'boolean', [null, 'a', 1, {}]) }
    } else if (def.type === 'any' || def.type === 'unknown') {
      // Anything passes and is handed back as it came: the check says
      // nothing about the field.
      if (checks.length) no(`a check on ${def.type}() is not carried`)
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
      const item = paths[`${ip}/*`]
      if ((item.q && !item.y) || 'd' in item) no('an array of optional items is not carried')
      delete item.y
      checks.forEach((c, rank) => { if (c._zod.def.check === 'custom') refine(c._zod.def, rank, ip, def) })
    } else if (def.type === 'object') {
      // A strict object (z.strictObject, .strict()): zod names every key it
      // was not told about in one issue of the object, after what it says
      // about the fields. The page finds those keys itself, as zod does
      // (every enumerable key, an inherited one and one holding undefined
      // included), so the written schema says nothing about them.
      // A loose object (z.looseObject, .loose(), .passthrough()): zod hands
      // back every key it was not told about, after the fields. The page
      // copies them the same way, so the written schema says nothing of them.
      const rest = def.catchall ? def.catchall._zod.def : null
      if (rest && (rest.type === 'unknown' || rest.type === 'any') && !(rest.checks || []).length) { here.l = 1; kinds.loose = true } else if (def.catchall) {
        if (rest.type !== 'never') no('a loose or catchall object is not carried')
        const said = [['\u0000a'], ['\u0000a', '\u0000b']].map((keys) => { const hit = issuesOf(node, Object.fromEntries(keys.map((k) => [k, 1]))).filter((i) => i.path.length === 0 && i.code === 'unrecognized_keys'); if (hit.length !== 1) no('zod did not report an unknown key of a strict object the way the build expects'); return hit[0].message })
        if (said[0] === 'Unrecognized key: "\u0000a"' && said[1] === 'Unrecognized keys: "\u0000a", "\u0000b"') here.s = 1
        else if (said[0] === said[1]) here.s = said[0]
        else no('a strict object whose message is a function of the keys is not carried')
        paths[''].z = 1
      }
      if (checks.some((c) => c._zod.def.check !== 'custom')) no('a check on an object other than refine() is not carried')
      out.type = 'object'; table[`${sp}/type`] = { t: typeEntry(node, 'object', [null, 'a', 1, true]) }
      out.properties = {}; const required = []; here.k = Object.keys(def.shape)
      for (const k of here.k) {
        if (k === '__proto__') no('a __proto__ key')
        const child = def.shape[k]
        out.properties[k] = walk(child, `${sp}/properties/${esc(k)}`, `${ip}/${esc(k)}`)
        const at = paths[`${ip}/${esc(k)}`]
        if (!at.q && !('d' in at)) required.push(k)
        // any() and unknown(): zod reports the key where it is absent, and
        // takes it where it holds undefined. The page looks for the key.
        if (at.y) {
          delete at.y
          const gone = issuesOf(node, {}).filter((i) => i.path.length === 1 && i.path[0] === k)
          if (gone.length > 1) no('zod reports more than one thing for a missing value here')
          if (gone.length) { at.m = [gone[0].code, gone[0].message]; paths[''].y = 1; kinds.missing = true }
        }
      }
      if (required.length) out.required = required
      checks.forEach((c, rank) => refine(c._zod.def, rank, ip, def))
    } else no(KINDS[def.type] || `${def.type} is not carried`)
    // null beside what the field takes: a type the check lets through, and
    // a member of an enum.
    if (nullable) {
      if (out.type) out.type = [out.type, 'null']
      if (out.enum) out.enum = out.enum.concat(null)
    }
    return out
  }
  if (schema._zod.def.type !== 'object') no(schema._zod.def.type === 'pipe' ? 'the schema is a transform or a pipe, which is not carried' : 'the schema is not an object')
  const json = walk(schema, '#', '')
  return { json, table, paths, rewrites, refines: refines.length ? refines : null, fns, strict: paths[''].z === 1, indexed, kinds }
}

// Why a plan cannot answer safeParse, where it can answer a resolver: an
// issue's path is rebuilt on the page from the place of the issue, a key as a
// string and an item of an array as a number, and a refine's own `path` is
// only known as text. So one that names an index, or that leads through an
// array, is refused; null where there is none.
export function parseRefusal (plan) {
  if (plan.indexed) return 'a refine whose path names an index is not carried for safeParse'
  for (const r of plan.refines || []) {
    let pat = r[0]
    if (r[4] === '') continue
    if (plan.paths[pat] && plan.paths[pat].a) return 'a refine with a path, written on an array, is not carried for safeParse'
    for (const seg of r[4].slice(1).split('/')) { pat += '/' + seg; if (plan.paths[pat] && plan.paths[pat].a) return 'a refine whose path leads into an array is not carried for safeParse' }
  }
  return null
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
// An object that is not a plain one is written with what it inherits, so a
// prototype an answer should not have is a difference like any other.
const show = (x) => JSON.stringify(x, (k, v) => v === undefined ? '\u0000undefined' : typeof v === 'number' && !Number.isFinite(v) ? '\u0000' + String(v) : v !== null && typeof v === 'object' && !Array.isArray(v) && k !== '\u0000proto' && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null ? { '\u0000proto': Object.getPrototypeOf(v), ...v } : v)

// Whether the plan answers as the schema does: zod's issues (path, code,
// message, in order) and the data it returns, on a document that passes, on
// that document with each field in turn missing and holding each value of
// the pool, and on documents with several fields wrong. `validate` is the
// check compiled from plan.json with plain errors.
export function selfCheck (schema, plan, validate, parse = false) {
  const leaves = []; const arrays = []; const objects = []
  const copyOf = (d) => { if (Array.isArray(d)) return d.map(copyOf); if (d === null || typeof d !== 'object' || Object.getPrototypeOf(d) !== Object.prototype) return d; const o = {}; for (const k of Object.keys(d)) { if (k === '__proto__') Object.defineProperty(o, k, { value: copyOf(d[k]), enumerable: true, writable: true, configurable: true }); else o[k] = copyOf(d[k]) } return o }
  const good = (node, ip) => {
    let def = node._zod.def; let optional = false
    // The sample is one the field itself takes, under optional(), nullable()
    // and default(): null and a missing value are handed to it further down.
    while (def.type === 'optional' || def.type === 'nullable' || def.type === 'default') { if (def.type !== 'nullable') optional = true; node = def.innerType; def = node._zod.def }
    if (def.type === 'object') { objects.push(ip); const out = {}; for (const [k, child] of Object.entries(def.shape)) out[k] = good(child, ip.concat(k)); return out }
    if (def.type === 'array') {
      // Two items where the bounds allow, the first of them varied below.
      const bound = (kind) => { const c = (def.checks || []).map((x) => x._zod.def).find((d) => d.check === kind || d.check === 'length_equals'); return c === undefined ? undefined : c.check === 'length_equals' ? c.length : kind === 'min_length' ? c.minimum : c.maximum }
      const min = bound('min_length') || 0; const max = bound('max_length')
      const n = Math.max(min, Math.min(2, max === undefined ? 2 : max))
      if (n > 50) throw new ZodRefused('an array that needs many items')
      const before = [leaves.length, arrays.length, objects.length]
      const item = good(def.element, ip.concat(0))
      // An array that has to be empty has no first item to vary.
      if (n === 0) { leaves.length = before[0]; arrays.length = before[1]; objects.length = before[2] }
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
  const at0 = (d, ip) => { let v = d; for (const k of ip) v = v[k]; return v }
  const set = (d, ip, v, drop) => { const o = copy(d); let at = o; for (let i = 0; i < ip.length - 1; i++) at = at[ip[i]]; if (drop) delete at[ip[ip.length - 1]]; else at[ip[ip.length - 1]] = v; return o }
  const docs = [base, {}, { ...copy(base), ['\u0000extra']: 1 }]
  // A key named __proto__, as JSON.parse writes one: it is a key like any
  // other and the fields it holds are not the document's.
  const own = (d, held) => Object.defineProperty(copy(d), '__proto__', { value: held, enumerable: true, writable: true, configurable: true })
  docs.push(own({}, copy(base)), own(base, { '\u0000extra': 1 }))
  for (const ip of leaves) if (ip.length === 1) docs.push(own(set(base, ip, undefined, true), { [ip[0]]: 1 }), own(set(base, ip, undefined, true), { [ip[0]]: at0(base, ip) }))
  // safeParse is handed anything, not only what a form holds.
  if (parse) docs.push(undefined, null, 'a', '', 0, 1, NaN, true, false, [], [base], new Date(0), Object.assign(Object.create({ inherited: 1 }), copy(base)))
  for (const ip of leaves) { docs.push(set(base, ip, undefined, true)); for (const v of POOL) docs.push(set(base, ip, v, false)) }
  // A value of the pool in the first item of an array that is also one short
  // of its minimum: what zod says about the item decides whether it still
  // says the array is short.
  for (const ip of leaves) for (const a of arrays) {
    if (a.min < 2 || a.ip.length >= ip.length || ip[a.ip.length] !== 0 || !a.ip.every((k, i) => ip[i] === k) || a.ip.some((x) => typeof x === 'number')) continue
    for (const v of POOL) { const d = set(base, ip, v, false); let at = d; for (const k of a.ip) at = at[k]; at.length = a.min - 1; docs.push(d) }
  }
  // An array empty, one short of its minimum, one over its maximum, long, and
  // with an item that is not there.
  for (const { ip, item, n, min, max } of arrays) {
    if (ip.some((x) => typeof x === 'number')) continue
    const of = (k) => Array.from({ length: k }, () => copyOf(item))
    for (const k of new Set([0, 1, Math.max(0, min - 1), min, n + 1, max === undefined ? 5 : max + 1, max === undefined ? 5 : max])) if (k <= 200) docs.push(set(base, ip, of(k), false))
    if (n > 0) { const holed = of(n); holed[0] = undefined; docs.push(set(base, ip, holed, false)) }
    for (const v of POOL) docs.push(set(base, ip, v, false))
    docs.push(set(base, ip, undefined, true))
  }
  // Parents of leaves, wrong as a whole.
  const parents = new Set(leaves.filter((ip) => ip.length > 1).map((ip) => JSON.stringify(ip.slice(0, -1))))
  for (const p of parents) { for (const v of [undefined, null, 'a', 1, [], {}]) docs.push(set(base, JSON.parse(p), v, false)); docs.push(set(base, JSON.parse(p), undefined, true)) }
  // Keys the schema does not name, in every object: one, two, one that
  // holds undefined, one that is inherited, and one beside a field that is
  // wrong or missing. A strict object names them; any other drops them.
  const at = (d, ip) => { let v = d; for (const k of ip) v = v[k]; return v }
  const extra = (d, ip, keys) => { const o = copy(d); const v = at(o, ip); for (const [k, x] of keys) v[k] = x; return o }
  for (const ip of objects) {
    docs.push(extra(base, ip, [['\u0000extra', 1]]), extra(base, ip, [['zz', 1], ['\u0000extra', 'a']]), extra(base, ip, [['\u0000extra', undefined]]))
    const first = leaves.find((l) => l.length === ip.length + 1 && ip.every((k, i) => l[i] === k))
    if (first) { docs.push(extra(set(base, first, null, false), ip, [['\u0000extra', 1]]), extra(set(base, first, undefined, true), ip, [['\u0000extra', 1]])) }
    if (ip.length) { const o = copy(base); const parent = at(o, ip.slice(0, -1)); parent[ip[ip.length - 1]] = Object.assign(Object.create({ inherited: 1 }), at(o, ip)); docs.push(o) }
  }
  // Several fields wrong at once, by a fixed sequence.
  let seed = 7; const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n }
  for (let i = 0; i < 60 && leaves.length > 1; i++) { let d = base; for (const ip of leaves) if (next(3) === 0) d = set(d, ip, POOL[next(POOL.length)], next(5) === 0); for (const ip of objects) if (next(4) === 0) d = extra(d, ip, [['\u0000extra', 1]]); docs.push(d) }
  // The answer of safeParse itself: success, the data, and each issue's
  // code, path and message, the path as zod gives it (a number for an index).
  if (parse) {
    const mine = RT.schema({ validate }, plan.table, plan.paths, plan.refines, plan.fns)
    for (const d of docs) {
      const want = schema.safeParse(copy(d)); const got = mine.safeParse(copy(d))
      if (want.success !== got.success) return `verdict on ${show(d)}`
      if (want.success) { if (show(want.data) !== show(got.data)) return `data on ${show(d)}`; continue }
      const theirs = want.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message }))
      if (show(got.error.issues) !== show(theirs)) return `issues on ${show(d)}: zod ${show(theirs)}, the build ${show(got.error.issues)}`
    }
    return null
  }
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
  // What the file imports by name as a value, and what it hands on from
  // other modules without naming it (`export { x } from`, `export * from`).
  const imports = new Map(); const reexports = { named: new Map(), star: [] }
  const one = (stmt, decl, exported) => {
    if (decl.type !== 'VariableDeclaration' || decl.kind !== 'const' || decl.declarations.length !== 1 || decl.declarations[0].id.type !== 'Identifier' || !decl.declarations[0].init) return
    const name = decl.declarations[0].id.name
    consts.set(name, { stmt, init: decl.declarations[0].init, exported })
    if (exported) exports.set(name, name)
  }
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type') {
      for (const sp of stmt.specifiers) if (sp.type === 'ImportSpecifier' && sp.importKind !== 'type') imports.set(sp.local.name, { stmt, sp, imported: sp.imported.name || sp.imported.value, source: stmt.source.value })
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
      else if (!stmt.source) { for (const sp of stmt.specifiers) if (sp.type === 'ExportSpecifier' && sp.exportKind !== 'type' && sp.local.type === 'Identifier') { exports.set(sp.exported.name || sp.exported.value, sp.local.name); const c = consts.get(sp.local.name); if (c) c.exported = true } }
      else { for (const sp of stmt.specifiers) if (sp.type === 'ExportSpecifier' && sp.exportKind !== 'type' && sp.local.type === 'Identifier') reexports.named.set(sp.exported.name || sp.exported.value, { source: stmt.source.value, imported: sp.local.name }) }
    } else if (stmt.type === 'ExportAllDeclaration' && stmt.exportKind !== 'type' && !stmt.exported) reexports.star.push(stmt.source.value)
  }
  // A constant declared inside a function, a component's body say: read like
  // one at the top of the file where the file declares that name once (the
  // caller checks). Its source still may name nothing but zod and constants,
  // so one built from a prop or a translation function is not read.
  walk(ast.program, (n, up) => {
    if (n.type !== 'VariableDeclaration' || !up || up[0].type === 'Program' || up[0].type === 'ExportNamedDeclaration') return
    if (up[0].type !== 'BlockStatement' || n.kind !== 'const' || n.declarations.length !== 1 || n.declarations[0].id.type !== 'Identifier' || !n.declarations[0].init) return
    const name = n.declarations[0].id.name
    if (!consts.has(name)) consts.set(name, { stmt: n, init: n.declarations[0].init, exported: false, local: true })
  })
  // `export { x }` written before the constant it names.
  for (const local of exports.values()) { const c = consts.get(local); if (c) c.exported = true }
  return resolver || !needResolver ? { zod, resolver, consts, exports, imports, reexports } : null
}

// A module a schema takes a part from, read as text and never run: its zod
// import where it has one, its constants, imports and exports, with the
// source they are cut from. Read once per version of the file.
const modules = new Map()
export function readModule (file, parse) {
  let stat
  try { stat = fs.statSync(file) } catch { return null }
  if (stat.size > 1 << 18) return null
  const had = modules.get(file)
  if (had && had.mtime === stat.mtimeMs) return had.info
  let info = null
  try {
    const code = fs.readFileSync(file, 'utf8')
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: false })
    info = { ...readZodFile(ast, false), code, file }
  } catch { info = null }
  modules.set(file, { mtime: stat.mtimeMs, info })
  return info
}

// The source that builds the schema `name` stands for, as the body of a
// function of zod's local name, with the constants it is made of before it;
// null where it names anything else (a value from outside, a function, a
// TypeScript expression): then it cannot be built outside the file.
export function schemaSource (name, info, code, exportedToo = false, out = {}, ctx = null) {
  // What the schema is made of, in the order it has to be written: a
  // constant of the file ({ name, text }), or a part imported by name from
  // another module ({ name, text, imp }), written as a function of zod that
  // holds that module's own constants, so two modules may use one name.
  const order = []; const seen = new Set()
  const fail = (why) => { if (out.why === undefined) out.why = why; return false }
  const zLocal = info.zod ? info.zod.local : null
  // The source of a constant without the TypeScript that only says what it
  // is: `as const`, `as T`, `satisfies T` and `!` are cut from the text.
  const textOf = (node) => {
    const cuts = []
    const ok = readable(node, cuts)
    if (!ok) return null
    cuts.sort((a, b) => a[0] - b[0])
    let text = ''; let at = node.start
    for (const [from, to] of cuts) { if (from < at) continue; text += code.slice(at, from); at = to }
    return text + code.slice(at, node.end)
  }
  const readable = (node, cuts) => {
    let ok = true
    const visitNode = (n, up) => {
      if (!ok) return false
      // A function is read where it is what refine() is given and reads
      // nothing but its own argument; its body is not walked.
      if (/^(?:Arrow)?FunctionExpression$/.test(n.type) && !n.async && !n.generator && up && up[0].type === 'CallExpression' && up[1] === 'arguments' && up[0].arguments[0] === n && up[0].callee.type === 'MemberExpression' && !up[0].callee.computed && up[0].callee.property.name === 'refine') {
        const outside = closesOver(code.slice(n.start, n.end))
        if (outside.length) ok = fail(`a refine reads ${outside.map((x) => '`' + x + '`').join(', ')} from outside its own argument, which the build does not carry`)
        return false
      }
      // A cast says nothing at run time: the expression under it is read,
      // and the cast leaves the text.
      if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression') {
        cuts.push([n.expression.end, n.end])
        if (n.expression.start > n.start) cuts.push([n.start, n.expression.start])
        walk(n.expression, visitNode)
        return false
      }
      if (n.type.startsWith('TS') || n.type.startsWith('JSX') || /Function|Class|Await|Yield|Assignment|Update|New|This|Import|TaggedTemplate|Sequence/.test(n.type)) { ok = fail(/Function/.test(n.type) ? 'the schema has a function in it (a refine, a transform or a message function), which the build does not carry' : n.type.startsWith('TS') ? 'the schema has TypeScript syntax in it (a type argument)' : `the schema has a ${n.type} in it, which the build does not read`); return }
      // Nothing but zod's own methods by name: no computed member, and none
      // of the names that reach a function constructor.
      if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && (n.computed || /^(?:constructor|prototype|__proto__|call|apply|bind)$/.test(n.property.name))) { ok = fail('the schema reads a member the build does not follow'); return }
      if (n.type === 'Identifier' && isName(n, up) && n.name !== zLocal && n.name !== 'undefined') {
        if (!info.consts.has(n.name) && !(ctx && info.imports && info.imports.has(n.name))) ok = fail(`the schema uses \`${n.name}\`, which is not zod, a constant of the file or a constant imported by name (a prop, a translation function and the like cannot be read)`)
        else if (!visit(n.name)) ok = false
      }
    }
    walk(node, visitNode)
    return ok
  }
  const visit = (nm) => {
    if (seen.has(nm)) return true
    seen.add(nm)
    const c = info.consts.get(nm)
    if (!c) {
      const imp = ctx && info.imports ? info.imports.get(nm) : undefined
      if (!imp) return fail(`\`${nm}\` is not a constant the build can read`)
      const part = moduleSource(imp.source, imp.imported, ctx, out, fail)
      if (!part) return false
      order.push({ name: nm, imp, text: `const ${nm} = ((${part.local}) => {\n${part.text}\n})(__ataZ);\n` })
      return true
    }
    // In the file of the call an exported constant has readers the build
    // does not see, so it cannot be taken out and is not read.
    if (c.exported && !exportedToo) return fail(`\`${nm}\` is exported, so other files may read it and it cannot leave this one`)
    const text = textOf(c.init)
    if (text === null) return false
    order.push({ name: nm, text: `const ${nm} = ${text};\n` })
    return true
  }
  // A name, or the expression written in the call itself.
  let last
  if (typeof name === 'string') { if (!visit(name)) return null; last = `return ${name};` } else { const text = textOf(name); if (text === null) return null; last = `return (${text});` }
  return { names: order.filter((o) => !o.imp).map((o) => o.name), imports: order.filter((o) => o.imp).map((o) => ({ name: o.name, stmt: o.imp.stmt, sp: o.imp.sp })), text: order.map((o) => o.text).join('') + last }
}

// The source of what a module exports under `exported`, as the body of a
// function of that module's name for zod: its constants, and what it takes
// from other modules in turn. The module is found by the build's resolver
// and read as text; `export { x } from` and `export * from` are followed.
// `ctx` is { resolve, read, file, depth, stack, zods }: `zods` collects the
// zod import of every module read, for the caller to hold them to one copy.
function moduleSource (source, exported, ctx, out, fail) {
  if (ctx.depth >= 8) return fail('the schema is put together from more modules than the build follows')
  const file = ctx.resolve(source, ctx.file)
  if (!file) return fail(`its module \`${source}\` was not found among the project's files`)
  const mod = ctx.read(file)
  if (!mod) return fail(`its module \`${source}\` could not be read`)
  const key = file + '\u0000' + exported
  if (ctx.stack.has(key)) return fail(`\`${exported}\` of \`${source}\` is made of itself`)
  const inner = { ...ctx, file, depth: ctx.depth + 1 }
  const local = mod.exports.get(exported)
  if (local === undefined) {
    const re = mod.reexports.named.get(exported)
    if (re) return moduleSource(re.source, re.imported, inner, out, fail)
    // `export * from`: the first of them that has the name. A miss in one
    // is not the reason to give, so each is asked with a reason of its own.
    for (const star of mod.reexports.star) {
      const quiet = {}
      const hit = moduleSource(star, exported, inner, quiet, (why) => { if (quiet.why === undefined) quiet.why = why; return false })
      if (hit) return hit
      if (quiet.found) return fail(quiet.why)
    }
    return fail(`\`${exported}\` is not a constant \`${source}\` exports`)
  }
  out.found = true
  if (mod.zod) ctx.zods.push({ file, source: mod.zod.source, kind: mod.zod.kind })
  ctx.stack.add(key)
  const sub = schemaSource(local, mod, mod.code, true, out, inner)
  ctx.stack.delete(key)
  if (!sub) return null
  return { text: sub.text, local: mod.zod ? mod.zod.local : '__ataNoZod' }
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
