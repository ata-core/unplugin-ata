// `schema.safeParse(value)` on a zod schema, compiled away
// (src/compile-away.js, src/zod-resolver.js): the file keeps its schema and
// its calls and ships without zod, where it reads what safeParse returns
// only through `success`, `data` and the `code`, `path` and `message` of
// each issue. Every claim here is a comparison with zod's own safeParse.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

import esbuildPlugin from '../src/esbuild.js'
import { planZod, parseRefusal, selfCheck, zodRuntime, ZodRefused } from '../src/zod-resolver.js'
import { __internal } from '../src/core.js'
import { forms, show, clone } from './zod-forms.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
const RT = zodRuntime(null, null, null)
// What a file may read of a result: the verdict, the data, and of each
// issue its code, path and message. A path keeps a number apart from a string.
const read = (r) => r.success ? { success: true, data: r.data } : { success: false, issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })) }
const ROOTS = [undefined, null, 'a', 0, NaN, true, [], [{}], new Date(0)]

describe('safeParse compiled away: the plan against zod', () => {
  it('answers as zod.safeParse on generated forms: verdict, data, and each issue with its path', () => {
    const seed = Number(process.env.ZOD_FORMS_SEED) || 1
    let taken = 0; let refused = 0; let answers = 0; let rejected = 0; let indexed = 0; const why = {}
    for (const { schema, docs } of forms(seed, 220)) {
      let plan
      try { plan = planZod(schema) } catch (e) { if (!(e instanceof ZodRefused)) throw e; refused++; continue }
      const no = parseRefusal(plan)
      if (no) { refused++; why[no] = (why[no] || 0) + 1; continue }
      const v = new ata.Validator(plan.json, { richErrors: false })
      let checked
      try { checked = selfCheck(schema, plan, (d) => v.validate(d)) || selfCheck(schema, plan, (d) => v.validate(d), true) } catch (e) { if (!(e instanceof ZodRefused)) throw e; refused++; continue }
      assert.equal(checked, null)
      taken++
      const mine = RT.schema({ validate: (d) => v.validate(d) }, plan.table, plan.paths, plan.refines, plan.fns)
      for (const d of [...docs, ...ROOTS]) {
        const theirs = schema.safeParse(clone(d)); const got = mine.safeParse(clone(d))
        const want = read(theirs)
        assert.equal(show(read(got)), show(want), `on ${show(d)}`)
        if (!want.success) { assert.equal(show(RT.flat(got.error)), show(theirs.error.flatten()), `flatten on ${show(d)}`); assert.equal(show(RT.flat(got.error)), show(z.flattenError(theirs.error))) }
        answers++
        if (!want.success) { rejected++; if (want.issues.some((i) => i.path.some((x) => typeof x === 'number'))) indexed++ }
      }
    }
    if (process.env.ZOD_FORMS_SEED) console.log(`seed ${seed}: ${taken} taken, ${refused} refused, ${answers} answers, ${rejected} rejected, ${indexed} with an index in a path, refusals for safeParse ${JSON.stringify(why)}`)
    assert.ok(taken >= 100, `only ${taken} of 220 forms were taken (${JSON.stringify(why)})`)
    assert.ok(rejected > answers / 2 && rejected < answers, `${rejected} of ${answers} answers were rejections`)
    if (seed === 1) assert.ok(indexed >= 100, `only ${indexed} answers had an index in a path`)
  })
  it('flattens an error as zod does, a field named like a method of every object included', () => {
    // The keys come from a refine's path: a field of those names is one zod
    // reads from the prototype of what it is given, and such a schema is
    // kept as written by the build's own check.
    const schema = z.object({ a: z.object({ b: z.string() }), l: z.array(z.string()) }).refine(() => false, 'Whole').refine(() => false, { message: 'Proto', path: ['__proto__'] }).refine(() => false, { message: 'Has', path: ['hasOwnProperty'] }).refine(() => false, { message: 'Str', path: ['toString', 'deeper'] }).refine(() => false, { message: 'Str too', path: ['toString'] })
    const plan = planZod(schema)
    assert.equal(parseRefusal(plan), null)
    const v = new ata.Validator(plan.json, { richErrors: false })
    assert.equal(selfCheck(schema, plan, (d) => v.validate(d), true), null)
    const mine = RT.schema({ validate: (d) => v.validate(d) }, plan.table, plan.paths, plan.refines, plan.fns)
    let seen = 0
    for (const d of [{}, { a: { b: 1 }, l: [1, 'a', 2] }, { a: { b: 'x' }, l: [] }, { a: { b: 'x' }, l: ['a'], extra: 1 }, null]) {
      const want = schema.safeParse(clone(d)); const got = mine.safeParse(clone(d))
      assert.equal(got.success, false)
      const flat = RT.flat(got.error)
      assert.equal(show(flat), show(want.error.flatten()), `on ${show(d)}`)
      assert.deepEqual(Object.keys(flat.fieldErrors), Object.keys(want.error.flatten().fieldErrors))
      if (Object.prototype.hasOwnProperty.call(flat.fieldErrors, '__proto__')) seen++
    }
    assert.ok(seen >= 2)
  })
  it('keeps a schema with a field every object inherits, which zod reads from the prototype', () => {
    for (const schema of [z.object({ toString: z.string() }), z.object({ constructor: z.number().optional(), a: z.string() })]) {
      const plan = planZod(schema)
      const v = new ata.Validator(plan.json, { richErrors: false })
      assert.notEqual(selfCheck(schema, plan, (d) => v.validate(d)) || selfCheck(schema, plan, (d) => v.validate(d), true), null)
    }
  })
  it('refuses a refine whose path the page could not write as zod does', () => {
    const cases = [
      z.object({ a: z.array(z.string()) }).refine(() => false, { path: ['a', 0] }),
      z.object({ a: z.array(z.string()) }).refine(() => false, { path: ['a', '0'] }),
      z.object({ a: z.array(z.string()).refine(() => false, { path: ['x'] }) }),
      z.object({ o: z.object({ l: z.array(z.string()) }).refine(() => false, { path: ['l', 'x'] }) }),
    ]
    for (const schema of cases) assert.notEqual(parseRefusal(planZod(schema)), null)
    for (const schema of [z.object({ a: z.string(), b: z.string() }).refine((v) => v.a === v.b, { path: ['b'] }), z.object({ o: z.object({ a: z.string() }).refine(() => false, { path: ['a', 'deeper'] }) }), z.object({ a: z.array(z.string()).refine(() => false) })]) {
      const plan = planZod(schema)
      assert.equal(parseRefusal(plan), null)
      const v = new ata.Validator(plan.json, { richErrors: false })
      assert.equal(selfCheck(schema, plan, (d) => v.validate(d), true), null)
    }
  })
  it('the build-time check notices a path that is wrong', () => {
    const schema = z.object({ lines: z.array(z.object({ qty: z.int().min(1) })).min(1), name: z.string() })
    const plan = planZod(schema)
    const v = new ata.Validator(plan.json, { richErrors: false })
    const check = () => selfCheck(schema, plan, (d) => v.validate(d), true)
    assert.equal(check(), null)
    for (const breakIt of [() => { delete plan.paths['/lines'].a }, () => { plan.paths['/lines'].o = 9 }, () => { plan.paths[''].k = ['lines'] }, () => { plan.table['#/properties/name/type'].t = { m: 'other' } }]) {
      const keep = JSON.stringify(plan)
      breakIt()
      let said
      try { said = check() } catch (e) { said = String(e) }
      assert.notEqual(said, null, String(breakIt))
      for (const k of Object.keys(plan.paths)) delete plan.paths[k]
      Object.assign(plan, JSON.parse(keep), { fns: plan.fns })
    }
    assert.equal(check(), null)
  })
})

const SIGNUP = `z.strictObject({ email: z.email(), password: z.string().min(8).max(72), age: z.int().min(13).optional(), tags: z.array(z.string().min(2)).max(3).optional(), terms: z.literal(true) })`
const DOCS = [
  { email: 'a@b.co', password: 'longenough', terms: true }, { email: 'a@b.co', password: 'longenough', terms: true, age: 13, tags: ['ab', 'cd'] },
  { email: 'no', password: 'a', terms: false, age: 12.5, tags: ['a', 'bc', 5] }, { email: 'a@b.co', password: 'longenough', terms: true, extra: 1, more: undefined },
  { tags: ['ab', 'cd', 'ef', 'gh'] }, {}, null, undefined, 'a', [], 7,
]

describe('safeParse compiled away: a build', () => {
  let dir
  before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'zod-safe-parse-')) })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })
  let n = 0
  const build = async (source, others = {}, options = {}) => {
    const esbuild = await import('esbuild')
    // A folder a build: the scan for a zod locale reads the whole project.
    const root = path.join(dir, 'b' + n++)
    await fs.mkdir(root, { recursive: true })
    for (const [name, text] of Object.entries(others)) await fs.writeFile(path.join(root, name), text)
    await fs.writeFile(path.join(root, 'page.ts'), source)
    const out = path.join(root, 'dist', 'page.out.mjs')
    const kept = []
    const logger = { info: (m) => kept.push(m), warn: (m) => kept.push(m) }
    await esbuild.build({ absWorkingDir: root, entryPoints: ['page.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', plugins: [esbuildPlugin({ verify: false, logger, ...options })] })
    return { text: await fs.readFile(out, 'utf8'), mod: await import(pathToFileURL(out).href), log: kept }
  }
  const HAS_ZOD = /ZodError|_zod\b/
  const real = (src) => new Function('z', `return ${src}`)(z)
  const sameAs = (check, schema, docs = DOCS) => { for (const d of docs) assert.equal(show(check(clone(d))), show(read(schema.safeParse(clone(d)))), `on ${show(d)}`) }
  const READ = `(d: unknown) => { const r = schema.safeParse(d); return r.success ? { success: true, data: r.data } : { success: false, issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })) } }`

  it('replaces a schema of the file, takes zod out of the bundle, and answers as zod', async () => {
    const { text, mod, log } = await build(`import { z } from 'zod'\nconst schema = ${SIGNUP}\ntype Signup = z.infer<typeof schema>\nexport const check = ${READ}\nexport const ok = (d: unknown): d is Signup => schema.safeParse(d).success\n`)
    assert.match(text, /__ataZSchema/)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    assert.doesNotMatch(text, /__ataZodResolver|@hookform/, 'the resolver came with it')
    sameAs(mod.check, real(SIGNUP))
    for (const d of DOCS) assert.equal(mod.ok(clone(d)), real(SIGNUP).safeParse(clone(d)).success)
    assert.ok(log.some((l) => /safeParse: 1 of 1 zod schema compiled at build time/.test(l)), log.join('\n'))
  })
  it('follows a result through names, patterns and loops', async () => {
    const SRC = `z.object({ name: z.string().min(2, 'Too short'), n: z.number().int().optional() })`
    const { text, mod } = await build(`import { z } from 'zod'
const schema = ${SRC}
export const a = (d: unknown) => { const { success, data, error } = schema.safeParse(d); if (success) return { success, data }; const issues = []; for (const { code, path, message } of error.issues) issues.push({ code, path, message }); return { success, issues } }
export const b = (d: unknown) => { const parsed = schema.safeParse(d); if (!parsed.success) { const first = parsed.error.issues[0]; return first ? first.path.join('.') + ': ' + first.message : '' } return parsed.data.name }
export const c = (d: unknown) => { const r = schema.safeParse(d); const e = r.error; return e ? e.issues.filter((i) => i.code !== 'custom').map((i) => i.message).length : 0 }
export const d = (x: unknown) => schema.safeParse(x).error?.issues.length ?? 0
`)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    const schema = real(SRC)
    const docs = [{ name: 'ab' }, { name: 'a', n: 1.5 }, { n: 'x' }, null, {}]
    sameAs(mod.a, schema, docs)
    for (const d of docs) {
      const r = schema.safeParse(clone(d))
      assert.equal(mod.b(clone(d)), r.success ? r.data.name : r.error.issues[0].path.join('.') + ': ' + r.error.issues[0].message)
      assert.equal(mod.c(clone(d)), r.success ? 0 : r.error.issues.length)
      assert.equal(mod.d(clone(d)), r.success ? 0 : r.error.issues.length)
    }
  })
  it('reads a schema declared in a function, one made of other constants, and one imported from a module of the project', async () => {
    const { text, mod } = await build(`import { z } from 'zod'
import { schema, type Signup } from './schemas'
const min = 2
const name = z.string().min(min)
export const check = ${READ}
export function inside (d: unknown) { const local = z.object({ name, on: z.boolean() }); const r = local.safeParse(d); return r.success ? r.data : r.error.issues.map((i) => i.path.join('/') + ' ' + i.code) }
export type { Signup }
`, { 'schemas.ts': `import { z } from 'zod'\nexport const schema = ${SIGNUP}\nexport type Signup = z.infer<typeof schema>\n` })
    assert.equal((text.match(/= \/\* @__PURE__ \*\/ __ataZSchema\(|= __ataZSchema\(/g) || []).length, 2, text.slice(0, 400))
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    sameAs(mod.check, real(SIGNUP))
    const local = z.object({ name: z.string().min(2), on: z.boolean() })
    for (const d of [{ name: 'ab', on: true, x: 1 }, { name: 'a' }, null]) { const r = local.safeParse(clone(d)); assert.equal(show(mod.inside(clone(d))), show(r.success ? r.data : r.error.issues.map((i) => i.path.join('/') + ' ' + i.code))) }
  })
  it('rewrites error.flatten() and z.flattenError(error), and leaves zod for a mapper or another helper', async () => {
    const SRC = `z.object({ name: z.string().min(2, 'Too short'), age: z.int().optional() }).refine((v) => v.name !== 'root', 'Not root')`
    const { text, mod } = await build(`import { z } from 'zod'
const schema = ${SRC}
export const a = (d: unknown) => { const r = schema.safeParse(d); if (!r.success) return { errors: r.error.flatten().fieldErrors }; return { data: r.data } }
export const b = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : z.flattenError(r.error) }
export const c = (d: unknown) => { const { success, error } = schema.safeParse(d); if (success) return null; const flat = error.flatten(); return [flat.formErrors, Object.keys(flat.fieldErrors)] }
export const e = (d: unknown) => schema.safeParse(d).error?.issues.map((i) => i.message) ?? []
`)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    assert.match(text, /__ataZFlat/)
    const schema = real(SRC)
    for (const d of [{ name: 'ab' }, { name: 'a', age: 1.5 }, { name: 'root' }, {}, null]) {
      const r = schema.safeParse(clone(d))
      assert.equal(show(mod.a(clone(d))), show(r.success ? { data: r.data } : { errors: r.error.flatten().fieldErrors }), `a on ${show(d)}`)
      assert.equal(show(mod.b(clone(d))), show(r.success ? null : z.flattenError(r.error)), `b on ${show(d)}`)
      assert.equal(show(mod.c(clone(d))), show(r.success ? null : [r.error.flatten().formErrors, Object.keys(r.error.flatten().fieldErrors)]), `c on ${show(d)}`)
    }
    const none = await build(`import { z } from 'zod'\nconst schema = z.object({ a: z.string() })\nexport const f = (d: unknown) => schema.safeParse(d).success\n`)
    assert.doesNotMatch(none.text, /__ataZFlat/)
    for (const use of [`r.error.flatten((i) => i.code)`, `z.flattenError(r.error, (i) => i.code)`, `z.treeifyError(r.error)`, `z.prettifyError(r.error)`, `r.error.format()`, `other.flattenError(r.error)`]) {
      const kept = await build(`import { z } from 'zod'\nconst other = { flattenError: (e: unknown) => e }\nconst schema = z.object({ a: z.string() })\nexport const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : ${use} }\n`)
      assert.match(kept.text, HAS_ZOD, use)
      assert.doesNotMatch(kept.text, /__ataZSchema/, use)
    }
  })
  it('compiles a schema a resolver and a safeParse both use', async () => {
    const SRC = `z.object({ email: z.email(), age: z.int().optional() })`
    const { text, mod } = await build(`import { z } from 'zod'\nimport { zodResolver } from '@hookform/resolvers/zod'\nconst schema = ${SRC}\nexport const resolver = zodResolver(schema)\nexport const check = ${READ}\n`)
    assert.match(text, /__ataZodResolver/); assert.match(text, /__ataZSchema/)
    assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle')
    sameAs(mod.check, real(SRC), [{ email: 'a@b.co' }, { email: 'x', age: 1.5 }, {}])
  })
  it('leaves zod where the result is used in a way the build does not follow, and says why', async () => {
    const uses = [
      `export const f = (d: unknown) => schema.safeParse(d)`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : r.error }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : r.error.issues }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : r.error.message }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : z.treeifyError(r.error) }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : r.error.issues.map((i) => i) }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : r.error.issues.map((i) => i.input) }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : r.error.issues.map((i) => (i as any).expected) }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : JSON.stringify(r.error.issues[0]) }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r.success ? null : r.error.issues.map(({ code, ...rest }) => rest) }`,
      `export const f = (d: unknown) => { let r = schema.safeParse(d); return r.success }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); return r['success'] }`,
      `export const f = (d: unknown) => { const r = schema.safeParse(d); log(r); return r.success }\nconst log = (x: unknown) => x`,
      `export const f = (d: unknown) => schema.safeParse(d).success\nexport const g = (d: unknown) => schema.parse(d)`,
      `export const f = (d: unknown) => schema.safeParse(d).success\nexport const g = schema`,
      `export const f = (d: unknown) => schema.safeParse(d).success\nexport const g = schema.shape`,
      `export const f = (d: unknown) => schema.safeParse(d, {}).success`,
      `export const f = async (d: unknown) => (await schema.safeParseAsync(d)).success`,
    ]
    for (const use of uses) {
      const { text, log } = await build(`import { z } from 'zod'\nconst schema = z.object({ a: z.string() })\n${use}\n`)
      assert.match(text, HAS_ZOD, `zod left the bundle for: ${use}`)
      assert.doesNotMatch(text, /__ataZSchema/, use)
      if (/safeParse\(d[,)]/.test(use)) assert.ok(log.some((l) => /left as written: page\.ts:\d+ schema\.safeParse\(\): /.test(l)), `${use}\n${log.join('\n')}`)
    }
  })
  it('leaves zod where the schema is not carried, is exported, or the application sets zod\'s messages', async () => {
    const READ1 = `export const f = (d: unknown) => schema.safeParse(d).success`
    for (const [src, others, why] of [
      [`import { z } from 'zod'\nconst schema = z.object({ a: z.string().nullable() })\n${READ1}\n`, {}, /nullable\(\) is not carried yet/],
      [`import { z } from 'zod'\nconst schema = z.string().min(2)\n${READ1}\n`, {}, /the schema is not an object/],
      [`import { z } from 'zod'\nexport const schema = z.object({ a: z.string() })\n${READ1}\n`, {}, /is exported/],
      [`import { z } from 'zod'\nconst schema = z.object({ l: z.array(z.string()) }).refine(() => true, { path: ['l', 0] })\n${READ1}\n`, {}, /a refine whose path names an index/],
      [`import { z } from 'zod'\nconst schema = z.object({ a: z.string() })\n${READ1}\n`, { 'setup.ts': `import { z } from 'zod'\nz.config(z.locales.fr())\n` }, null],
    ]) {
      const { text, log } = await build(src, others)
      assert.match(text, HAS_ZOD, src)
      assert.doesNotMatch(text, /__ataZSchema/, src)
      if (why) assert.ok(log.some((l) => /left as written: page\.ts:\d+ schema\.safeParse\(\)/.test(l) && why.test(l)), `${src}\n${log.join('\n')}`)
    }
    const off = await build(`import { z } from 'zod'\nconst schema = z.object({ a: z.string() })\n${READ1}\n`, {}, { zodSafeParse: false })
    assert.match(off.text, HAS_ZOD)
  })
  it('says nothing of a safeParse that is not a zod schema of the project', async () => {
    const { text, log } = await build(`import { thing } from './thing'\nexport const f = (d: unknown) => thing.safeParse(d).success\nimport { z } from 'zod'\nexport const s = z.string()\nconst own = { safeParse: (d: unknown) => ({ success: true, data: d }) }\nexport const g = (d: unknown) => own.safeParse(d).success\n`, { 'thing.ts': `export const thing = { safeParse: (d: unknown) => ({ success: d === 1 }) }\n` })
    assert.doesNotMatch(text, /__ataZSchema/)
    assert.ok(!log.some((l) => /safeParse/.test(l)), log.join('\n'))
  })
})
