// `zodResolver(schema)` compiled away (src/zod-resolver.js): the page keeps
// its zod schema and its call, and ships without zod. The written resolver
// has to answer as the real zodResolver does, so every claim here is a
// comparison with the package's own resolver from node_modules.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { toNestErrors, validateFieldsNatively } from '@hookform/resolvers'
import { appendErrors } from 'react-hook-form'

import esbuildPlugin from '../src/esbuild.js'
import { planZod, selfCheck, zodRuntime, ZodRefused } from '../src/zod-resolver.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
const RT = zodRuntime(toNestErrors, validateFieldsNatively, appendErrors)
const show = (x) => JSON.stringify(x, (k, v) => v === undefined ? '\u0000undefined' : typeof v === 'number' && !Number.isFinite(v) ? '\u0000' + String(v) : v)
const OPTS = [{ fields: {}, shouldUseNativeValidation: false }, { fields: {}, shouldUseNativeValidation: false, criteriaMode: 'all' }]
const clone = (d) => { if (Array.isArray(d)) return d.map(clone); if (d === null || typeof d !== 'object' || Object.getPrototypeOf(d) !== Object.prototype) return d; const o = {}; for (const k of Object.keys(d)) o[k] = clone(d[k]); return o }
const OUTSIDE = 'x'
const VALUES = [undefined, null, '', 'a', 'ab', 'abc', 'https://example.com', ' http://a.b/c ', 'mailto:x@y.z', 'http://', 'a:b', 'https://exa\nmple.com', '42', ' 7 ', '1e3', 'Ab!', 'A@b', '0x10', '  ab ', ' A@B.CO ', 'ABC', ' 12345 ', 'Stra\u00dfe', 'abcdefghij', 'a@b.co', '12345', 'x', 'b', 'c', 0, 1, 7, 18.5, 25, 80, -3, NaN, Infinity, 2 ** 60, true, false, [], {}, ['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], { a0: 1 }, { length: 1 }, { length: 99 }, new Date(0), '123e4567-e89b-42d3-a456-426614174000']

// Form schemas made by a fixed sequence: strings, numbers, booleans, enums,
// literals, optional fields and nested objects, with and without messages.
function forms (seed0, count) {
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

describe('zodResolver compiled away: the plan against zod', () => {
  it('answers as the real zodResolver on generated forms, in both criteria modes, with and without raw', async () => {
    let taken = 0; let refused = 0; let answers = 0; let rejected = 0; const why = {}
    const note = (e) => { const k = e.message.replace(/^[^:]*: /, ''); why[k] = (why[k] || 0) + 1 }
    // ZOD_FORMS_SEED: the same comparison on another sequence of forms.
    const seed = Number(process.env.ZOD_FORMS_SEED) || 1
    let strict = 0; let named = 0
    for (const { schema, docs } of forms(seed, 220)) {
      let plan
      try { plan = planZod(schema) } catch (e) { if (!(e instanceof ZodRefused)) throw e; refused++; note(e); continue }
      const v = new ata.Validator(plan.json, { richErrors: false })
      // The check refuses a form it finds no passing document for (rules
      // that contradict each other); any other form has to pass it.
      let checked
      try { checked = selfCheck(schema, plan, (d) => v.validate(d)) } catch (e) { if (!(e instanceof ZodRefused)) throw e; refused++; note(e); continue }
      assert.equal(checked, null)
      taken++; if (plan.strict) strict++
      for (const raw of [false, true]) {
        const mine = RT.resolver({ validate: (d) => v.validate(d) }, plan.table, plan.paths, { raw }, plan.refines, plan.fns)
        const theirs = zodResolver(schema, undefined, { raw })
        for (const d of docs) for (const o of OPTS) {
          const want = await theirs(clone(d), undefined, o)
          const got = await mine(clone(d), undefined, o)
          assert.equal(show(got), show(want), `on ${show(d)} with ${JSON.stringify(o)}, raw ${raw}`)
          answers++; if (Object.keys(want.errors).length) rejected++
          if (show(want.errors).includes('unrecognized_keys')) named++
        }
      }
    }
    if (process.env.ZOD_FORMS_SEED) console.log(`seed ${seed}: ${taken} taken (${strict} with a strict object), ${refused} refused, ${answers} answers, ${rejected} rejected, ${named} naming an unknown key`)
    if (seed === 1) assert.ok(strict >= 20 && named >= 100, `${strict} forms with a strict object, ${named} answers naming an unknown key`)
    assert.ok(taken >= 120, `only ${taken} of 220 forms were taken (${refused} refused: ${JSON.stringify(why)})`)
    assert.ok(rejected > answers / 2 && rejected < answers, `${rejected} of ${answers} answers were rejections`)
  })
  it('coerces a number as zod does, an optional one left alone when it is not there', async () => {
    const schema = z.object({ a: z.coerce.number().min(1, 'At least one').optional(), b: z.coerce.number().int(), c: z.array(z.coerce.number().max(9)).optional() })
    const plan = planZod(schema)
    const v = new ata.Validator(plan.json, { richErrors: false })
    assert.equal(selfCheck(schema, plan, (d) => v.validate(d)), null)
    const mine = RT.resolver({ validate: (d) => v.validate(d) }, plan.table, plan.paths, undefined, plan.refines, plan.fns)
    const theirs = zodResolver(schema)
    for (const d of [{ a: undefined, b: '3' }, { b: '3' }, { a: '', b: '' }, { a: 'x', b: '2.5' }, { a: null, b: null }, { a: '5', b: true, c: ['1', 2, '', 'x', '10'] }, { b: [] , c: 'no' }, {}]) for (const o of OPTS) assert.equal(show(await mine(clone(d), undefined, o)), show(await theirs(clone(d), undefined, o)), `on ${show(d)}`)
  })
  it('runs a refine where zod runs it: after what is written before it, whatever is written after', async () => {
    const schema = z.object({
      n: z.number().refine((v) => v > 10, 'Over ten').int('Whole'),
      s: z.string().refine((v) => v.startsWith('a'), { message: 'Starts with a', abort: true }).min(3, 'Three'),
      pair: z.object({ a: z.string().min(2, 'Two'), b: z.string() }).refine((v) => v.a === v.b, { message: 'Same', path: ['b'] }),
    }).refine((v) => v.s !== 'abc')
    const plan = planZod(schema)
    const v = new ata.Validator(plan.json, { richErrors: false })
    assert.equal(selfCheck(schema, plan, (d) => v.validate(d)), null)
    const mine = RT.resolver({ validate: (d) => v.validate(d) }, plan.table, plan.paths, undefined, plan.refines, plan.fns)
    const theirs = zodResolver(schema)
    for (const d of [
      { n: 2.5, s: 'b', pair: { a: 'x', b: 'y' } }, { n: 20.5, s: 'ab', pair: { a: 'xy', b: 'xy' } }, { n: 12, s: 'abc', pair: { a: 'xy', b: 'xy', c: 1 } },
      { n: 'x', s: 5, pair: { a: 1, b: 'y' } }, { n: 3, s: 'abcd', pair: { a: 'xy' } }, { n: 11, s: 'abcd', pair: null }, {},
    ]) for (const o of OPTS) assert.equal(show(await mine(clone(d), undefined, o)), show(await theirs(clone(d), undefined, o)), `on ${show(d)}`)
  })
  it('checks url() with the platform URL parser, as zod does, and hands back the trimmed value', async () => {
    const schema = z.object({ site: z.string().min(1, 'Required').url('Not a URL'), home: z.url().optional() })
    const plan = planZod(schema)
    const v = new ata.Validator(plan.json, { richErrors: false })
    assert.equal(selfCheck(schema, plan, (d) => v.validate(d)), null)
    const mine = RT.resolver({ validate: (d) => v.validate(d) }, plan.table, plan.paths, undefined, plan.refines, plan.fns)
    const theirs = zodResolver(schema)
    for (const d of [{ site: 'https://example.com' }, { site: '  https://example.com/a b\n ' }, { site: 'https://exa\tmple.com', home: ' mailto:x@y.z ' }, { site: '' }, { site: 'http://' }, { site: 'nope', home: 'a:b' }, { site: 5, home: '' }, {}]) for (const o of OPTS) assert.equal(show(await mine(clone(d), undefined, o)), show(await theirs(clone(d), undefined, o)), `on ${show(d)}`)
  })
  it('the build-time check notices a table that is wrong', () => {
    const schema = z.object({ name: z.string().min(2, 'Too short').max(5), age: z.number().int().min(18).optional() })
    const plan = planZod(schema)
    const v = new ata.Validator(plan.json, { richErrors: false })
    const check = () => selfCheck(schema, plan, (d) => v.validate(d))
    assert.equal(check(), null)
    for (const breakIt of [() => { plan.table['#/properties/name/minLength'][2] = 'other' }, () => { plan.table['#/properties/name/maxLength'][1] = 'too_small' }, () => { plan.paths['/name'].u[1] = 'gone' }, () => { plan.paths[''].k = ['name'] }, () => { plan.table['#/properties/age/type'].i[0] = 9 }]) {
      const keep = JSON.stringify(plan)
      breakIt()
      assert.notEqual(check(), null)
      Object.assign(plan, JSON.parse(keep))
    }
  })
  it('says nothing of an array\'s length where zod stopped on a number that is not whole under it', async () => {
    const schema = z.object({ l: z.array(z.number().int()).min(3, 'Three'), m: z.array(z.object({ n: z.int(), s: z.string() })).min(2).optional() })
    const plan = planZod(schema)
    const v = new ata.Validator(plan.json, { richErrors: false })
    assert.equal(selfCheck(schema, plan, (d) => v.validate(d)), null)
    const mine = RT.resolver({ validate: (d) => v.validate(d) }, plan.table, plan.paths, undefined, plan.refines, plan.fns)
    const theirs = zodResolver(schema)
    for (const d of [{ l: [0.5] }, { l: [1, 0.5] }, { l: ['x'] }, { l: [1] }, { l: [1, 2, 3], m: [{ n: 0.5, s: 'a' }] }, { l: [1, 2, 3], m: [{ n: 'x', s: 'a' }] }, { l: [1, 2, 3], m: [{ n: 1, s: 5 }] }, { l: [2 ** 60], m: [{ n: 2 ** 60, s: 'a' }] }]) for (const o of OPTS) assert.equal(show(await mine(clone(d), undefined, o)), show(await theirs(clone(d), undefined, o)), `on ${show(d)}`)
    // The check made at build time holds this: with the int issue no longer
    // stopping what is above it, it says so.
    const loose = new Function('__ataZNest', '__ataZNative', '__ataZAppend', (await fs.readFile(path.join(here, '..', 'src', 'zod-resolver-rt.js'), 'utf8')).replace('entry.i[2], 1, ip, 2]', 'entry.i[2], 1, ip]') + '\nreturn __ataZRun')(null, null, null)
    const got = loose((d) => v.validate(d), plan.table, plan.paths, { l: [0.5] }, plan.refines, plan.fns)
    assert.equal(got.issues.length, 2)
  })
  it('names the unknown keys of a strict object as zod does, where zod names them', async () => {
    const SRC = () => z.strictObject({
      email: z.email(), age: z.int().min(13).max(120).optional(), terms: z.literal(true),
      address: z.strictObject({ city: z.string().min(2), zip: z.string() }, { error: 'Bad address' }).optional(),
      lines: z.array(z.strictObject({ sku: z.string() }).refine((v) => v.sku !== 'x', 'No x')).max(2).optional(),
      open: z.object({ a: z.string().optional() }).optional(),
    }).refine((v) => v.email !== 'a@b.co', { message: 'Taken', path: ['email'] })
    const schema = SRC()
    const plan = planZod(schema)
    assert.equal(plan.strict, true)
    assert.equal(plan.json.additionalProperties, undefined)
    const v = new ata.Validator(plan.json, { richErrors: false })
    assert.equal(selfCheck(schema, plan, (d) => v.validate(d)), null)
    const ok = { email: 'x@y.co', terms: true }
    const inherited = Object.assign(Object.create({ from: 'a prototype' }), ok)
    const hidden = Object.defineProperty({ ...ok }, 'hidden', { value: 1, enumerable: false })
    const docs = [
      ok, { ...ok, extra: 1 }, { z: 1, ...ok, y: undefined }, { ...ok, 'k"e\\y': 1, '\u00fc/~': 2 }, inherited, hidden, { ...ok, [Symbol('s')]: 1 },
      { email: 'a@b.co', terms: true, extra: 1 }, { email: 5, age: 12.5, extra: 1 }, { extra: 1 }, { ...ok, age: 2 ** 60 }, { ...ok, age: 12 }, { ...ok, age: '13' },
      { ...ok, address: { city: 'a', zip: '1', street: 'x', no: 2 } }, { ...ok, address: 5, extra: 1 }, { ...ok, address: { extra: 1 } }, { ...ok, address: Object.assign(Object.create({ far: 1 }), { city: 'ab', zip: '1' }) },
      { ...ok, lines: [{ sku: 'x', q: 1 }, { sku: 1, r: 1 }] }, { ...ok, lines: [{ sku: 'a', q: 1 }, { sku: 'b' }, { sku: 'c', z: 1 }] }, { ...ok, lines: [null, { q: undefined }] },
      { ...ok, open: { a: 'x', anything: 1 } }, null, [], 'a',
    ]
    const dup = (d) => { if (d === null || typeof d !== 'object') return d; if (Array.isArray(d)) return d.map(dup); const o = Object.create(Object.getPrototypeOf(d)); for (const k of Reflect.ownKeys(d)) Object.defineProperty(o, k, { ...Object.getOwnPropertyDescriptor(d, k), value: dup(d[k]) }); return o }
    let named = 0
    for (const raw of [false, true]) {
      const mine = RT.resolver({ validate: (d) => v.validate(d) }, plan.table, plan.paths, { raw }, plan.refines, plan.fns)
      const theirs = zodResolver(SRC(), undefined, { raw })
      for (const d of docs) for (const o of OPTS) {
        const want = await theirs(dup(d), undefined, o)
        assert.equal(show(await mine(dup(d), undefined, o)), show(want), `on ${show(d)} with ${JSON.stringify(o)}, raw ${raw}`)
        if (show(want).includes('unrecognized_keys')) named++
      }
    }
    assert.ok(named >= 40, `only ${named} answers named an unknown key`)
    // The check made at build time sees a strict object that is not held.
    for (const breakIt of [() => { delete plan.paths[''].s }, () => { delete plan.paths[''].z }, () => { plan.paths[''].s = 'Other' }, () => { delete plan.paths['/address'].s }, () => { plan.paths['/address'].s = 1 }, () => { delete plan.paths['/lines/*'].s }, () => { plan.paths['/open'].s = 1 }, () => { plan.table['#/properties/age/type'].i[0] = 5 }]) {
      const keep = JSON.stringify(plan)
      breakIt()
      assert.notEqual(selfCheck(schema, plan, (d) => v.validate(d)), null, String(breakIt))
      for (const k of Object.keys(plan.paths)) delete plan.paths[k]
      Object.assign(plan, JSON.parse(keep), { fns: plan.fns })
    }
    assert.equal(selfCheck(schema, plan, (d) => v.validate(d)), null)
  })
  it('refuses what it does not carry', () => {
    for (const schema of [
      z.object({ a: z.string().refine((v) => v !== OUTSIDE) }), z.object({ a: z.string().superRefine(() => {}) }), z.object({ a: z.string().optional().refine((v) => v !== 'x') }), z.object({ a: z.string().refine(async (v) => v !== 'x') }), z.object({ a: z.string().refine((v) => v !== 'x', { error: (i) => String(i.input) }) }), z.object({ a: z.string().min(1).trim().max(5) }), z.object({ a: z.string().normalize() }), z.object({ a: z.coerce.string() }), z.object({ a: z.coerce.boolean() }), z.object({ a: z.any() }), z.object({ a: z.array(z.string().optional()) }), z.object({ a: z.array(z.string()).min(1).min(2) }), z.object({ a: z.set(z.string()) }),
      z.object({ a: z.string().url().min(10) }), z.object({ a: z.url({ protocol: /^https$/ }) }), z.object({ a: z.string().url({ normalize: true }) }), z.object({ a: z.string().nullable() }), z.object({ a: z.union([z.string(), z.number()]) }), z.object({ a: z.string().default('x') }),
      z.looseObject({ a: z.string() }), z.object({ a: z.string() }).catchall(z.string()), z.object({ a: z.string() }).passthrough(), z.strictObject({ a: z.string() }, { error: (i) => i.code === 'unrecognized_keys' ? i.keys.join() : undefined }), z.object({ n: z.int32() }), z.object({ n: z.int().int() }), z.object({ a: z.string().transform((v) => v.length) }), z.object({ a: z.date() }), z.string(),
    ]) assert.throws(() => planZod(schema), ZodRefused)
  })
})

const FIELDS = `username: z.string().min(2, { message: 'Username must be at least 2 characters.' }).max(30),
  email: z.string().email('Please enter a valid email.'),
  age: z.number().int().min(18).optional(),
  role: z.enum(['admin', 'user']),`
const DOCS = [
  { username: 'ayse', email: 'ayse@example.com', role: 'admin' },
  { username: 'ayse', email: 'ayse@example.com', role: 'user', age: 30, extra: 1 },
  { username: 'a', email: 'nope', role: 'x', age: 3.5 },
  { username: 5, email: null, age: NaN }, {},
]

describe('zodResolver compiled away: a build', () => {
  let dir
  before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'zod-resolver-')) })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })
  const build = async (name, source, others = {}) => {
    const esbuild = await import('esbuild')
    for (const [n, text] of Object.entries(others)) await fs.writeFile(path.join(dir, n), text)
    await fs.writeFile(path.join(dir, name), source)
    // Under dist/, which the build's source scan does not read: a bundle that
    // kept zod holds zod's own source, locale tables and all.
    const out = path.join(dir, 'dist', name.replace(/\.\w+$/, '.out.mjs'))
    await esbuild.build({ absWorkingDir: dir, entryPoints: [name], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', plugins: [esbuildPlugin({ verify: false, report: false })] })
    return { text: await fs.readFile(out, 'utf8'), mod: await import(pathToFileURL(out).href + '?t=' + Date.now()) }
  }
  const same = async (resolver) => {
    const schema = z.object({ username: z.string().min(2, { message: 'Username must be at least 2 characters.' }).max(30), email: z.string().email('Please enter a valid email.'), age: z.number().int().min(18).optional(), role: z.enum(['admin', 'user']) })
    const real = zodResolver(schema)
    for (const d of DOCS) for (const o of OPTS) assert.equal(show(await resolver(clone(d), undefined, o)), show(await real(clone(d), undefined, o)), `on ${show(d)}`)
  }
  const HAS_ZOD = /ZodError|_zod\b/

  it('replaces the call, takes zod out of the bundle, and answers as zodResolver', async () => {
    const { text, mod } = await build('form.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst limits = { min: 2 }\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema)\n`)
    assert.match(text, /__ataZodResolver/)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
  })
  it('replaces a form written the way zod 4 writes it: a strict object, z.email() and z.int()', async () => {
    const SRC = `z.strictObject({ email: z.email(), password: z.string().min(8).max(72), name: z.string().min(1).max(80), age: z.int().min(13).max(120).optional(), plan: z.enum(['free', 'pro', 'team']).optional(), terms: z.literal(true) })`
    const { text, mod } = await build('zod4.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst signup = ${SRC}\nexport const resolver = zodResolver(signup)\nconst plain = z.object({ email: z.email() })\nexport const second = zodResolver(plain)\n`)
    assert.equal((text.match(/__ataZodResolver\(/g) || []).length, 2)
    assert.match(text, /__ataZStrict/)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    const real = zodResolver(new Function('z', `return ${SRC}`)(z))
    const ok = { email: 'a@b.co', password: 'longenough', name: 'a', terms: true }
    for (const d of [ok, { ...ok, age: 13, plan: 'pro' }, { ...ok, age: 12.5 }, { ...ok, age: 12, extra: 1, more: undefined }, { ...ok, terms: false, plan: 'x' }, { extra: 1 }, { email: 'no', password: 'a', name: '', age: 'x', terms: 1 }, {}]) for (const o of OPTS) assert.equal(show(await mod.resolver(clone(d), undefined, o)), show(await real(clone(d), undefined, o)), `on ${show(d)}`)
    // A file with no strict object does not carry the part that reads keys.
    const { text: none } = await build('zod4-plain.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst plain = z.object({ email: z.email(), age: z.int().optional() })\nexport const resolver = zodResolver(plain)\n`)
    assert.match(none, /__ataZodResolver/)
    assert.doesNotMatch(none, /__ataZStrict/)
  })
  it('reads a schema made of other constants of the file, and a namespace import', async () => {
    const { text, mod } = await build('parts.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport * as zod from 'zod'\nconst roles = ['admin', 'user']\nconst username = zod.string().min(2, { message: 'Username must be at least 2 characters.' }).max(30)\nconst formSchema = zod.object({ username, email: zod.string().email('Please enter a valid email.'), age: zod.number().int().min(18).optional(), role: zod.enum(roles) })\nexport const resolver = zodResolver(formSchema)\n`)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
  })
  it('reads a schema written in the call itself, and one that rewrites its strings', async () => {
    const { text, mod } = await build('inline.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nexport const resolver = zodResolver(z.object({\n  ${FIELDS}\n}))\nconst signup = z.object({ email: z.email('Enter a valid email').toLowerCase(), name: z.string().trim().min(2, 'Too short').toUpperCase() })\nexport const second = zodResolver(signup)\n`)
    assert.equal((text.match(/__ataZodResolver\(/g) || []).length, 2)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
    const real = zodResolver(z.object({ email: z.email('Enter a valid email').toLowerCase(), name: z.string().trim().min(2, 'Too short').toUpperCase() }))
    for (const d of [{ email: 'A@B.CO', name: '  ab ' }, { email: ' a@b.co', name: ' a ' }, { email: 5 }, {}]) for (const o of OPTS) assert.equal(show(await mod.second(clone(d), undefined, o)), show(await real(clone(d), undefined, o)), `on ${show(d)}`)
  })
  it('reads a form with arrays of strings and of objects', async () => {
    const SRC = `z.object({ tags: z.array(z.string().min(2, 'Too short')).min(1, 'Pick one').max(3), lines: z.array(z.object({ sku: z.string().regex(/^[A-Z]{3}$/, 'Bad sku'), qty: z.number().int().min(1) })).nonempty('No lines') })`
    const { text, mod } = await build('arrays.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst order = ${SRC}\nexport const resolver = zodResolver(order)\n`)
    assert.match(text, /__ataZodResolver/)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    const real = zodResolver(new Function('z', `return ${SRC}`)(z))
    for (const d of [
      { tags: ['ab'], lines: [{ sku: 'ABC', qty: 1, note: 'x' }] }, { tags: [], lines: [] }, { tags: ['a', 'bc', 'd'], lines: [{ sku: 'abc', qty: 0.5 }, { qty: 2 }, 5] },
      { tags: ['a', 'b', 'c', 'd'], lines: [{ sku: 'ABC', qty: 1 }] }, { tags: 'ab', lines: { length: 0 } }, { tags: [1, undefined, 'ok'], lines: [null] }, {},
    ]) for (const o of OPTS) assert.equal(show(await mod.resolver(clone(d), undefined, o)), show(await real(clone(d), undefined, o)), `on ${show(d)}`)
  })
  it('carries a refine whose function reads only its argument, and keeps one that reads more', async () => {
    const SRC = `z.object({ password: z.string().min(8, 'Too short'), confirm: z.string() }).refine((v) => v.password === v.confirm, { message: 'Passwords differ', path: ['confirm'] })`
    const { text, mod } = await build('refine.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst passwords = ${SRC}\nexport const resolver = zodResolver(passwords)\n`)
    assert.match(text, /__ataZodResolver/)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    const real = zodResolver(new Function('z', `return ${SRC}`)(z))
    for (const d of [{ password: 'longenough', confirm: 'longenough' }, { password: 'longenough', confirm: 'other' }, { password: 'short', confirm: 'x' }, { password: 5, confirm: 5 }, {}]) for (const o of OPTS) assert.equal(show(await mod.resolver(clone(d), undefined, o)), show(await real(clone(d), undefined, o)), `on ${show(d)}`)
    const kept = await build('refine-outside.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst banned = ['root']\nconst form = z.object({ name: z.string().refine((v) => !banned.includes(v)) })\nexport const resolver = zodResolver(form)\n`)
    assert.doesNotMatch(kept.text, /__ataZodResolver/)
    assert.match(kept.text, HAS_ZOD)
  })
  it('reads a schema declared inside the component, where it is made of zod alone', async () => {
    const { text, mod } = await build('inside.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nexport function useResolver() {\n  const formSchema = z.object({\n  ${FIELDS}\n  })\n  return zodResolver(formSchema)\n}\nexport function useOther(t) {\n  const other = z.object({ name: z.string().min(2, t('short')) })\n  return zodResolver(other)\n}\n`)
    assert.equal((text.match(/__ataZodResolver\(/g) || []).length, 1, 'the one made of zod alone, not the one that calls t()')
    assert.match(text, HAS_ZOD, 'the second schema still needs zod')
    await same(mod.useResolver())
  })
  it('keeps the type a TypeScript file infers from the schema', async () => {
    const { text, mod } = await build('typed.ts', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport type FormValues = z.infer<typeof formSchema>\nexport const resolver = zodResolver(formSchema)\nexport const first = (v: FormValues): string => v.username\n`)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
  })
  const SCHEMAS = `import { z } from 'zod'\nconst roles = ['admin', 'user']\nexport const formSchema = z.object({\n  username: z.string().min(2, { message: 'Username must be at least 2 characters.' }).max(30),\n  email: z.string().email('Please enter a valid email.'),\n  age: z.number().int().min(18).optional(),\n  role: z.enum(roles),\n})\nexport type FormValues = z.infer<typeof formSchema>\nconst other = z.object({ q: z.string() })\nexport { other as searchSchema }\n`
  it('reads a schema the file imports from another module of the project', async () => {
    const { text, mod } = await build('imports.ts', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { formSchema, type FormValues } from './schemas-a'\nexport const resolver = zodResolver(formSchema)\nexport const first = (v: FormValues): string => v.username\n`, { 'schemas-a.ts': SCHEMAS })
    assert.match(text, /__ataZodResolver/)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
  })
  it('keeps a type the file infers from an imported schema, and reads an export written as a list', async () => {
    const { text, mod } = await build('imports-typed.ts', `import { zodResolver } from '@hookform/resolvers/zod'\nimport type { z } from 'zod'\nimport { formSchema, searchSchema } from './schemas-b'\ntype Values = z.infer<typeof formSchema>\nexport const resolver = zodResolver(formSchema)\nexport const search = zodResolver(searchSchema)\nexport const first = (v: Values): string => v.username\n`, { 'schemas-b.ts': SCHEMAS })
    assert.equal((text.match(/__ataZodResolver\(/g) || []).length, 2)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
    const real = zodResolver(z.object({ q: z.string() }))
    for (const d of [{ q: 'a' }, {}, { q: 1, x: 2 }]) assert.equal(show(await mod.search(clone(d), undefined, OPTS[0])), show(await real(clone(d), undefined, OPTS[0])))
  })
  it('leaves the call where the imported schema is also used as a value, or its module is made of more than zod', async () => {
    for (const [name, source, others] of [
      ['imports-used.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { formSchema } from './schemas-c.js'\nexport const resolver = zodResolver(formSchema)\nexport const parse = (v) => formSchema.safeParse(v)\n`, { 'schemas-c.js': SCHEMAS.replace(/export type[^\n]*\n/, '') }],
      ['imports-parts.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { formSchema } from './schemas-d.js'\nexport const resolver = zodResolver(formSchema)\n`, { 'parts-d.js': `import { z } from 'zod'\nexport const email = z.string().email()\n`, 'schemas-d.js': `import { z } from 'zod'\nimport { email } from './parts-d.js'\nexport const formSchema = z.object({ email })\n` }],
      ['imports-fn.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { formSchema } from './schemas-e.js'\nexport const resolver = zodResolver(formSchema)\n`, { 'schemas-e.js': `import { z } from 'zod'\nconst make = () => z.object({ a: z.string() })\nexport const formSchema = make()\n` }],
    ]) {
      const { text } = await build(name, source, others)
      assert.doesNotMatch(text, /__ataZodResolver/, `${name}: the call was replaced`)
      assert.match(text, HAS_ZOD, `${name}: zod left a bundle that still needs it`)
    }
  })
  it('replaces nothing in an application that sets zod\'s locale or a global error map', async () => {
    const other = await fs.mkdtemp(path.join(here, 'fixtures', 'zod-resolver-locale-'))
    try {
      const esbuild = await import('esbuild')
      await fs.writeFile(path.join(other, 'setup.js'), `import { z } from 'zod'\nz.config(z.locales.fr())\n`)
      await fs.writeFile(path.join(other, 'form.js'), `import './setup.js'\nimport { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema)\n`)
      const out = path.join(other, 'form.out.mjs')
      await esbuild.build({ absWorkingDir: other, entryPoints: ['form.js'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', plugins: [esbuildPlugin({ verify: false, report: false })] })
      assert.doesNotMatch(await fs.readFile(out, 'utf8'), /__ataZodResolver/)
    } finally { await fs.rm(other, { recursive: true, force: true }) }
  })
  it('replaces nothing in a file transformed before the scan for a zod locale has run', async () => {
    const { unpluginFactory } = await import('../src/index.js')
    const file = path.join(dir, 'early.js')
    const code = `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema)\n`
    const hooks = unpluginFactory({ root: dir, verify: false, report: false })
    const early = await hooks.transform.call({}, code, file)
    assert.ok(!early || !early.code.includes('__ataZodResolver('), 'replaced with no scan behind it')
    await hooks.buildStart.call({})
    assert.match((await hooks.transform.call({}, code, file)).code, /__ataZodResolver\(/)
  })
  it('keeps the call where a name the schema uses is declared again in the file', async () => {
    const { unpluginFactory } = await import('../src/index.js')
    const head = "import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst min = 2\n"
    const hooks = unpluginFactory({ root: dir, verify: false, report: false })
    await hooks.buildStart.call({})
    const run = async (name, body) => { const out = await hooks.transform.call({}, head + body + '\n', path.join(dir, name + '.js')); return !!out && out.code.includes('__ataZodResolver(') }
    assert.equal(await run('control', 'const s = z.object({ name: z.string().min(min) })\nexport const r = zodResolver(s)'), true, 'the control is replaced')
    for (const [name, body] of [
      ['param', 'export function useR(min) { const s = z.object({ name: z.string().min(min) }); return zodResolver(s) }'],
      ['prop', 'export function useR({ min }) { const s = z.object({ name: z.string().min(min) }); return zodResolver(s) }'],
      ['inner-let', 'export function useR() { let min = 5; const s = z.object({ name: z.string().min(min) }); return zodResolver(s) }'],
      ['inner-const', 'export function useR() { const min = 5; const s = z.object({ name: z.string().min(min) }); return zodResolver(s) }'],
      ['in-call', 'export function useR(min) { return zodResolver(z.object({ name: z.string().min(min) })) }'],
      ['catch', 'export function useR() { try { throw 1 } catch (min) { const s = z.object({ name: z.string().min(min) }); return zodResolver(s) } }'],
    ]) assert.equal(await run(name, body), false, `${name}: the build would read the top-level min`)
  })
  it('leaves the call as written where the schema is used as a value, is exported, or is not carried', async () => {
    for (const [name, source] of [
      ['used.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema)\nexport const parse = (v) => formSchema.safeParse(v)\n`],
      ['exported.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nexport const formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema)\n`],
      ['refined.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n}).superRefine((v, ctx) => { if (v.username === v.email) ctx.addIssue({ code: 'custom', message: 'Same' }) })\nexport const resolver = zodResolver(formSchema)\n`],
      ['outside.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst min = Number(process.env.MIN_NAME || 2)\nconst formSchema = z.object({ username: z.string().min(min), email: z.string().email('Please enter a valid email.'), age: z.number().int().min(18).optional(), role: z.enum(['admin', 'user']) })\nexport const resolver = zodResolver(formSchema)\n`],
      ['options.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema, undefined, { raw: true })\n`],
    ]) {
      const { text } = await build(name, source)
      assert.doesNotMatch(text, /__ataZodResolver/, `${name}: the call was replaced`)
      assert.match(text, HAS_ZOD, `${name}: zod left a bundle that still needs it`)
    }
  })
})
