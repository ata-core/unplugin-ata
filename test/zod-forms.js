// Form schemas made by a fixed sequence, with documents for each, and the two
// helpers the comparisons with zod share. Not a test file: the zodResolver
// tests and the safeParse tests both read it.

import { z } from 'zod'

export const show = (x) => JSON.stringify(x, (k, v) => v === undefined ? '\u0000undefined' : typeof v === 'number' && !Number.isFinite(v) ? '\u0000' + String(v) : v)
export const clone = (d) => { if (Array.isArray(d)) return d.map(clone); if (d === null || typeof d !== 'object' || Object.getPrototypeOf(d) !== Object.prototype) return d; const o = {}; for (const k of Object.keys(d)) o[k] = clone(d[k]); return o }
const VALUES = [undefined, null, '', 'a', 'ab', 'abc', 'https://example.com', ' http://a.b/c ', 'mailto:x@y.z', 'http://', 'a:b', 'https://exa\nmple.com', '42', ' 7 ', '1e3', 'Ab!', 'A@b', '0x10', '  ab ', ' A@B.CO ', 'ABC', ' 12345 ', 'Stra\u00dfe', 'abcdefghij', 'a@b.co', '12345', 'x', 'b', 'c', 0, 1, 7, 18.5, 25, 80, -3, NaN, Infinity, 2 ** 60, true, false, [], {}, ['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], { a0: 1 }, { length: 1 }, { length: 99 }, new Date(0), '123e4567-e89b-42d3-a456-426614174000']

// Form schemas made by a fixed sequence: strings, numbers, booleans, enums,
// literals, optional fields and nested objects, with and without messages.
export function forms (seed0, count) {
  let seed = seed0
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) / 0x7fffff }
  const int = (n) => Math.floor(rnd() * n); const pick = (a) => a[int(a.length)]; const maybe = (p) => rnd() < p
  const msg = () => maybe(0.5) ? undefined : pick(['Required', 'Too short', 'Bad value.', { message: 'Custom message' }])
  const str = () => {
    const plain = !maybe(0.15)
    if (maybe(0.06)) return maybe(0.5) ? z.url(msg()) : (maybe(0.5) ? z.string().min(1, msg()) : z.string()).url(msg())
    // A password's rules: several patterns on one field, and nothing else that contradicts them.
    if (plain && maybe(0.12)) { let p = z.string().min(2 + int(3), msg()).regex(/[A-Z]/, msg()).regex(/[!@#]/, msg()); if (maybe(0.5)) p = p.regex(/[0-9]/, msg()); return p }
    let s = plain ? z.string(maybe(0.2) ? { error: 'Must be text' } : undefined) : pick([() => z.email(msg()), () => z.uuid(msg())])(); const steps = []
    const rewrite = (x) => pick([(y) => y.trim(), (y) => y.toLowerCase(), (y) => y.toUpperCase()])(x)
    if (plain && maybe(0.25)) { s = rewrite(s); if (maybe(0.3)) s = rewrite(s) }
    if (maybe(0.6)) steps.push((x) => x.min(int(4), msg())); if (maybe(0.4)) steps.push((x) => x.max(3 + int(6), msg())); if (maybe(0.3)) steps.push((x) => x.email ? x.email(msg()) : x); if (maybe(0.2)) steps.push((x) => x.regex(pick([/^[a-z]+$/, /\d/, /^[0-9]{5}$/]), msg())); if (maybe(0.1)) steps.push((x) => x.length(2 + int(3), msg())); if (maybe(0.1)) steps.push((x) => x.uuid ? x.uuid(msg()) : x)
    // A shuffle whose result does not depend on the engine's sort.
    for (let i = steps.length - 1; i > 0; i--) { const j = int(i + 1); const t = steps[i]; steps[i] = steps[j]; steps[j] = t }
    if (maybe(0.2)) steps.splice(int(steps.length + 1), 0, (x) => x.refine(pick([(v) => v.length % 2 === 0, (v) => !v.includes('b'), (v) => v !== 'abc']), pick([undefined, 'Refused', { message: 'Refused!', abort: true }])))
    for (const f of steps) s = f(s)
    if (maybe(0.15)) s = rewrite(s)
    return s
  }
  const num = () => { let s = maybe(0.25) ? z.coerce.number(maybe(0.3) ? 'Must be a number' : undefined) : z.number(maybe(0.2) ? 'Must be a number' : undefined); const whole = maybe(0.2); if (whole) s = z.int(msg()); else if (maybe(0.5)) s = s.int(msg()); if (maybe(0.5)) s = maybe(0.5) ? s.min(int(20), msg()) : s.gt(int(20), msg()); if (maybe(0.4)) s = maybe(0.5) ? s.max(30 + int(50), msg()) : s.lt(30 + int(50), msg()); if (maybe(0.2)) s = s.positive(msg()); if (maybe(0.15)) s = s.refine((n) => n % 2 === 0, pick([undefined, 'Even only'])); return s }
  const leaf = () => pick([str, str, str, num, () => z.boolean(), () => z.enum(['a', 'b', 'c'], msg()), () => z.literal(pick(['x', 7, true]))])()
  const arr = (depth) => { let s = z.array(pick([str, num, () => z.enum(['a', 'b']), () => depth < 2 ? obj(depth + 1) : str()])()); const lo = int(3); if (maybe(0.5)) s = s.min(lo, msg()); if (maybe(0.4)) s = s.max(lo + int(3), msg()); else if (maybe(0.15)) s = s.length(1 + int(3), msg()); if (maybe(0.25)) s = s.refine((a) => new Set(a.map((x) => JSON.stringify(x))).size === a.length, pick([undefined, 'No repeats'])); return s }
  const obj = (depth) => { const shape = {}; const n = 1 + int(5); for (let i = 0; i < n; i++) { let f = depth < 2 && maybe(0.15) ? obj(depth + 1) : maybe(0.2) ? arr(depth) : leaf(); if (maybe(0.3)) f = f.optional(); shape[pick(['a', 'b', 'c', 'name', 'email', 'age', 'x/y', 'k~1']) + i] = f }
    let o = maybe(0.3) ? z.strictObject(shape, maybe(0.25) ? { error: 'Not this' } : undefined) : z.object(shape); const first = Object.keys(shape)[0]
    if (maybe(0.3)) o = o.refine(pick([(v) => Object.keys(v).length !== 2, (v) => Object.values(v)[0] !== Object.values(v)[1], (v) => !('extra' in v)]), pick([undefined, 'Not together', { message: 'At the first field', path: [first] }, { message: 'Stops', abort: true }]))
    if (maybe(0.1)) o = o.refine((v) => Object.keys(v).length < 4, { message: 'Too many', path: ['nowhere', 0] })
    return o }
  const good = (node) => { const d = node._zod.def; if (d.type === 'optional') return maybe(0.3) ? undefined : good(d.innerType); if (d.type === 'object') return doc(node, 0.05); if (d.type === 'array') return Array.from({ length: int(5) }, () => maybe(0.2) ? pick(VALUES) : good(d.element)); if (d.type === 'enum') return pick(Object.values(d.entries)); if (d.type === 'literal') return d.values[0]; if (d.type === 'boolean') return maybe(0.5); if (d.type === 'number') return pick([18, 25, 21, 20, 30, 1]); return pick(['abc', 'a@b.co', '12345', 'abcd', 'ab', ' ab ', 'A@B.co ', 'https://example.com', '123e4567-e89b-42d3-a456-426614174000']) }
  const doc = (node, pBad) => { const out = {}; for (const [k, child] of Object.entries(node._zod.def.shape)) { if (maybe(pBad)) { if (maybe(0.3)) continue; out[k] = pick(VALUES) } else { const v = good(child); if (v !== undefined || maybe(0.3)) out[k] = v } } if (maybe(0.2)) out.extra = 1; if (maybe(0.08)) out.more = undefined; return out }
  const out = []
  for (let i = 0; i < count; i++) { const schema = obj(0); out.push({ schema, docs: Array.from({ length: 24 }, (_, j) => j === 0 ? {} : doc(schema, j < 6 ? 0 : 0.35)) }) }
  return out
}

// Forms for the kinds around a field: nullable(), nullish(), optional() and
// default() in every order, on strings, numbers, booleans, enums, arrays and
// nested objects. Each is written as source, so the same form can be handed
// to zod here and to a build as a file, with documents made for it: one that
// passes, and for every field in turn that field missing, undefined, null and
// holding a value of each wrong type.
const WRONG = [null, undefined, '', 'a', 'abc', ' ab ', 'a@b.co', '3', 0, 1, 0.5, 7, -2, NaN, true, false, [], ['a'], [null], {}, { a: 1 }, new Date(0)]
export function kindForms (seed0, count) {
  let seed = seed0
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) / 0x7fffff }
  const int = (n) => Math.floor(rnd() * n); const pick = (a) => a[int(a.length)]; const maybe = (p) => rnd() < p
  const msg = () => maybe(0.5) ? '' : pick(["'Required'", "'Bad value.'", "{ message: 'Custom message' }"])
  const lit = (v) => JSON.stringify(v)
  const leaves = [
    () => ({ src: `z.string().min(2${msg() && ', ' + msg()}).max(8)`, ok: ['abc', 'abcd'], d: ['abc', 'toolongtopass', ''] }),
    () => ({ src: `z.string(${msg()})`, ok: ['', 'x'], d: ['', 'x'] }),
    () => ({ src: 'z.string().trim().min(1)', ok: [' ab ', 'x'], d: ['x', ' ab '] }),
    () => ({ src: `z.email(${msg()})`, ok: ['a@b.co'], d: ['a@b.co', 'no'] }),
    () => ({ src: `z.string().regex(/^[a-z]+$/${msg() && ', ' + msg()})`, ok: ['abc'], d: ['abc'] }),
    () => ({ src: `z.number().int(${msg()}).min(1)`, ok: [1, 18], d: [5, 0] }),
    () => ({ src: `z.number(${msg()}).max(100)`, ok: [0.5, 3], d: [0, 0.5] }),
    () => ({ src: 'z.coerce.number().min(1)', ok: ['3', 4], d: [2] }),
    () => ({ src: 'z.boolean()', ok: [true, false], d: [false, true] }),
    () => ({ src: `z.enum(['a', 'b', 'c']${msg() && ', ' + msg()})`, ok: ['a', 'b'], d: ['a', 'z'] }),
    () => ({ src: `z.literal(${pick(["'x'", '7', 'true'])})`, ok: null, d: [] }),
    () => ({ src: "z.string().min(2).refine((v) => v !== 'abc', 'Refused')", ok: ['abcd'], d: ['abcd'] }),
    () => ({ src: 'z.any()', ok: ['x', { a: 1 }], d: ['x', 0] }),
    () => ({ src: 'z.unknown()', ok: [7, ['a']], d: [7, null] }),
  ]
  const leaf = () => { const l = pick(leaves)(); if (l.ok === null) { const v = new Function('return ' + /\((.*)\)$/.exec(l.src)[1])(); l.ok = [v]; l.d = [v] } return l }
  const arr = (depth) => { const el = depth < 2 && maybe(0.3) ? obj(depth + 1) : wrap(leaf(), true); const lo = int(2); return { src: `z.array(${el.src})${maybe(0.5) ? `.min(${lo})` : ''}${maybe(0.3) ? `.max(${lo + 2})` : ''}`, item: el, ok: [[sample(el), sample(el)].slice(0, lo + 1)], d: [[], [sample(el)]] } }
  // The wrappers, in the orders people write them.
  const WRAPS = ['', '', '.nullable()', '.nullable()', '.nullable()', '.nullish()', '.nullish()', '.optional()', '.optional().nullable()', '.nullable().optional()', '.default(D)', '.default(D)', '.default(D).optional()', '.optional().default(D)', '.nullable().default(D)', '.nullable().default(null)', '.default(D).nullable()', '.nullish().default(D)']
  const wrap = (f, item) => {
    let w = item ? pick(['', '', '.nullable()', '.nullable()']) : pick(WRAPS)
    // An object's default is rarely one it passes: most of those are refused.
    if (f.kids && w.includes('default') && maybe(0.7)) w = pick(['.nullable()', '.nullish()'])
    if (!w) return f
    return { ...f, src: f.src + w.replace('D', () => lit(maybe(0.9) ? f.d[0] : pick(f.d))), wrapped: w }
  }
  const obj = (depth) => {
    const kids = {}; const n = 1 + int(4)
    for (let i = 0; i < n; i++) kids[pick(['a', 'b', 'name', 'x/y', 'k~1']) + i] = wrap(depth < 2 && maybe(0.2) ? obj(depth + 1) : maybe(0.2) ? arr(depth) : leaf(), false)
    let src = `${maybe(0.25) ? 'z.strictObject' : 'z.object'}({ ${Object.entries(kids).map(([k, f]) => `${lit(k)}: ${f.src}`).join(', ')} })`
    if (maybe(0.2)) src += `.refine((v) => Object.keys(v).length !== 2${maybe(0.5) ? ", 'Not two'" : ''})`
    const f = { src, kids }
    f.ok = [sample(f)]; f.d = [{}, sample(f)]
    return f
  }
  function sample (f) { if (!f.kids) return f.ok[0]; const o = {}; for (const [k, c] of Object.entries(f.kids)) o[k] = sample(c); return o }
  const places = (f, at, out) => { if (f.kids) for (const [k, c] of Object.entries(f.kids)) { out.push(at.concat(k)); places(c, at.concat(k), out) } else if (f.item && f.ok[0].length) { out.push(at.concat(0)); places(f.item, at.concat(0), out) } return out }
  const set = (d, ip, v, drop) => { const o = clone(d); let at = o; for (let i = 0; i < ip.length - 1; i++) at = at[ip[i]]; if (drop) { if (Array.isArray(at)) at.length = 0; else delete at[ip[ip.length - 1]] } else at[ip[ip.length - 1]] = v; return o }
  const out = []
  for (let i = 0; i < count; i++) {
    const f = obj(0)
    const base = sample(f)
    const at = places(f, [], [])
    const docs = [base, {}]
    for (const ip of at) { docs.push(set(base, ip, undefined, true)); for (const v of WRONG) docs.push(set(base, ip, v, false)) }
    // Several places wrong at once.
    for (let j = 0; j < 12 && at.length > 1; j++) { let d = base; for (const ip of at) if (maybe(0.3)) { try { d = set(d, ip, pick(WRONG), maybe(0.3)) } catch { /* its parent is no longer an object */ } } docs.push(d) }
    out.push({ src: f.src, schema: new Function('z', `return ${f.src}`)(z), docs })
  }
  return out
}
