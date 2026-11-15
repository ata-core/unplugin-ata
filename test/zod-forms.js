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
