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
const clone = (d) => { if (d === null || typeof d !== 'object' || Array.isArray(d) || Object.getPrototypeOf(d) !== Object.prototype) return d; const o = {}; for (const k of Object.keys(d)) o[k] = clone(d[k]); return o }
const VALUES = [undefined, null, '', 'a', 'ab', 'abc', 'abcdefghij', 'a@b.co', '12345', 'x', 'b', 'c', 0, 1, 7, 18.5, 25, 80, -3, NaN, Infinity, 2 ** 60, true, false, [], {}, ['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], { a0: 1 }, { length: 1 }, { length: 99 }, new Date(0), '123e4567-e89b-42d3-a456-426614174000']

// Form schemas made by a fixed sequence: strings, numbers, booleans, enums,
// literals, optional fields and nested objects, with and without messages.
function forms (seed0, count) {
  let seed = seed0
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) / 0x7fffff }
  const int = (n) => Math.floor(rnd() * n); const pick = (a) => a[int(a.length)]; const maybe = (p) => rnd() < p
  const msg = () => maybe(0.5) ? undefined : pick(['Required', 'Too short', 'Bad value.', { message: 'Custom message' }])
  const str = () => {
    let s = z.string(maybe(0.2) ? { error: 'Must be text' } : undefined); const steps = []
    if (maybe(0.6)) steps.push((x) => x.min(int(4), msg())); if (maybe(0.4)) steps.push((x) => x.max(3 + int(6), msg())); if (maybe(0.3)) steps.push((x) => x.email(msg())); if (maybe(0.2)) steps.push((x) => x.regex(pick([/^[a-z]+$/, /\d/, /^[0-9]{5}$/]), msg())); if (maybe(0.1)) steps.push((x) => x.length(2 + int(3), msg())); if (maybe(0.1)) steps.push((x) => x.uuid(msg()))
    steps.sort(() => rnd() - 0.5); for (const f of steps) s = f(s); return s
  }
  const num = () => { let s = z.number(maybe(0.2) ? 'Must be a number' : undefined); if (maybe(0.5)) s = s.int(msg()); if (maybe(0.5)) s = maybe(0.5) ? s.min(int(20), msg()) : s.gt(int(20), msg()); if (maybe(0.4)) s = maybe(0.5) ? s.max(30 + int(50), msg()) : s.lt(30 + int(50), msg()); if (maybe(0.2)) s = s.positive(msg()); return s }
  const leaf = () => pick([str, str, str, num, () => z.boolean(), () => z.enum(['a', 'b', 'c'], msg()), () => z.literal(pick(['x', 7, true]))])()
  const obj = (depth) => { const shape = {}; const n = 1 + int(5); for (let i = 0; i < n; i++) { let f = depth < 2 && maybe(0.15) ? obj(depth + 1) : leaf(); if (maybe(0.3)) f = f.optional(); shape[pick(['a', 'b', 'c', 'name', 'email', 'age', 'x/y', 'k~1']) + i] = f } return z.object(shape) }
  const good = (node) => { const d = node._zod.def; if (d.type === 'optional') return maybe(0.3) ? undefined : good(d.innerType); if (d.type === 'object') return doc(node, 0.05); if (d.type === 'enum') return pick(Object.values(d.entries)); if (d.type === 'literal') return d.values[0]; if (d.type === 'boolean') return maybe(0.5); if (d.type === 'number') return pick([18, 25, 21, 20, 30, 1]); return pick(['abc', 'a@b.co', '12345', 'abcd', 'ab', '123e4567-e89b-42d3-a456-426614174000']) }
  const doc = (node, pBad) => { const out = {}; for (const [k, child] of Object.entries(node._zod.def.shape)) { if (maybe(pBad)) { if (maybe(0.3)) continue; out[k] = pick(VALUES) } else { const v = good(child); if (v !== undefined || maybe(0.3)) out[k] = v } } if (maybe(0.2)) out.extra = 1; return out }
  const out = []
  for (let i = 0; i < count; i++) { const schema = obj(0); out.push({ schema, docs: Array.from({ length: 24 }, (_, j) => j === 0 ? {} : doc(schema, j < 6 ? 0 : 0.35)) }) }
  return out
}

describe('zodResolver compiled away: the plan against zod', () => {
  it('answers as the real zodResolver on generated forms, in both criteria modes, with and without raw', async () => {
    let taken = 0; let refused = 0; let answers = 0; let rejected = 0
    for (const { schema, docs } of forms(1, 220)) {
      let plan
      try { plan = planZod(schema) } catch (e) { if (!(e instanceof ZodRefused)) throw e; refused++; continue }
      const v = new ata.Validator(plan.json, { richErrors: false })
      // The check refuses a form it finds no passing document for (rules
      // that contradict each other); any other form has to pass it.
      let checked
      try { checked = selfCheck(schema, plan, (d) => v.validate(d)) } catch (e) { if (!(e instanceof ZodRefused)) throw e; refused++; continue }
      assert.equal(checked, null)
      taken++
      for (const raw of [false, true]) {
        const mine = RT.resolver({ validate: (d) => v.validate(d) }, plan.table, plan.paths, { raw })
        const theirs = zodResolver(schema, undefined, { raw })
        for (const d of docs) for (const o of OPTS) {
          const want = await theirs(clone(d), undefined, o)
          const got = await mine(clone(d), undefined, o)
          assert.equal(show(got), show(want), `on ${show(d)} with ${JSON.stringify(o)}, raw ${raw}`)
          answers++; if (Object.keys(want.errors).length) rejected++
        }
      }
    }
    assert.ok(taken >= 150, `only ${taken} of 220 forms were taken (${refused} refused)`)
    assert.ok(rejected > answers / 2 && rejected < answers, `${rejected} of ${answers} answers were rejections`)
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
  it('refuses what it does not carry', () => {
    for (const schema of [
      z.object({ a: z.string().refine((v) => v !== 'x') }), z.object({ a: z.string().trim().min(1) }), z.object({ a: z.coerce.number() }), z.object({ a: z.array(z.string()) }),
      z.object({ a: z.string().url() }), z.object({ a: z.string().nullable() }), z.object({ a: z.union([z.string(), z.number()]) }), z.object({ a: z.string().default('x') }),
      z.strictObject({ a: z.string() }), z.object({ a: z.string().transform((v) => v.length) }), z.object({ a: z.date() }), z.string(),
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
  const build = async (name, source) => {
    const esbuild = await import('esbuild')
    await fs.writeFile(path.join(dir, name), source)
    const out = path.join(dir, name.replace(/\.\w+$/, '.out.mjs'))
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
  it('reads a schema made of other constants of the file, and a namespace import', async () => {
    const { text, mod } = await build('parts.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport * as zod from 'zod'\nconst roles = ['admin', 'user']\nconst username = zod.string().min(2, { message: 'Username must be at least 2 characters.' }).max(30)\nconst formSchema = zod.object({ username, email: zod.string().email('Please enter a valid email.'), age: zod.number().int().min(18).optional(), role: zod.enum(roles) })\nexport const resolver = zodResolver(formSchema)\n`)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
  })
  it('keeps the type a TypeScript file infers from the schema', async () => {
    const { text, mod } = await build('typed.ts', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport type FormValues = z.infer<typeof formSchema>\nexport const resolver = zodResolver(formSchema)\nexport const first = (v: FormValues): string => v.username\n`)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    await same(mod.resolver)
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
  it('leaves the call as written where the schema is used as a value, is exported, or is not carried', async () => {
    for (const [name, source] of [
      ['used.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema)\nexport const parse = (v) => formSchema.safeParse(v)\n`],
      ['exported.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nexport const formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema)\n`],
      ['refined.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n}).refine((v) => v.username !== v.email)\nexport const resolver = zodResolver(formSchema)\n`],
      ['outside.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst min = Number(process.env.MIN_NAME || 2)\nconst formSchema = z.object({ username: z.string().min(min), email: z.string().email('Please enter a valid email.'), age: z.number().int().min(18).optional(), role: z.enum(['admin', 'user']) })\nexport const resolver = zodResolver(formSchema)\n`],
      ['options.js', `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst formSchema = z.object({\n  ${FIELDS}\n})\nexport const resolver = zodResolver(formSchema, undefined, { raw: true })\n`],
    ]) {
      const { text } = await build(name, source)
      assert.doesNotMatch(text, /__ataZodResolver/, `${name}: the call was replaced`)
      assert.match(text, HAS_ZOD, `${name}: zod left a bundle that still needs it`)
    }
  })
})
