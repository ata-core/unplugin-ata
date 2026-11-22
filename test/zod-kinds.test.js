// The kinds around a field, compiled away (src/zod-resolver.js): nullable(),
// nullish(), optional() and default() in any order. Every claim is a
// comparison with zod: the real zodResolver for a form, zod's own safeParse
// for a schema, on a document that passes and on documents with each field
// missing, undefined, null and of a wrong type.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { toNestErrors, validateFieldsNatively } from '@hookform/resolvers'
import { appendErrors } from 'react-hook-form'

import esbuildPlugin from '../src/esbuild.js'
import { planZod, parseRefusal, selfCheck, zodRuntime, zodRuntimeFor, ZodRefused } from '../src/zod-resolver.js'
import { __internal } from '../src/core.js'
import { compileAway } from '../src/compile-away.js'
import { kindForms, show, clone } from './zod-forms.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
const RT = zodRuntime(toNestErrors, validateFieldsNatively, appendErrors)
const OPTS = [{ fields: {}, shouldUseNativeValidation: false }, { fields: {}, shouldUseNativeValidation: false, criteriaMode: 'all' }]
const read = (r) => r.success ? { success: true, data: r.data } : { success: false, issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })) }
const ROOTS = [undefined, null, 'a', 0, NaN, true, [], [{}], new Date(0)]
const SEED = Number(process.env.ZOD_FORMS_SEED) || 1
const COUNT = Number(process.env.ZOD_KINDS_COUNT) || 260

// A form the plan takes, or the reason it does not.
const planned = (schema) => {
  let plan
  try { plan = planZod(schema) } catch (e) { if (!(e instanceof ZodRefused)) throw e; return { why: e.message } }
  const v = new ata.Validator(plan.json, { richErrors: false })
  const validate = (d) => v.validate(d)
  let said
  try { said = selfCheck(schema, plan, validate) || (parseRefusal(plan) ? null : selfCheck(schema, plan, validate, true)) } catch (e) { if (!(e instanceof ZodRefused)) throw e; return { why: e.message } }
  return { plan, validate, said }
}

describe('zod kinds compiled away: the plan against zod', () => {
  it('answers as zodResolver and as safeParse on generated forms with nullable, nullish, optional, default, any and unknown fields and loose objects', async () => {
    const tally = { taken: 0, refused: 0, nulls: 0, defaults: 0, missing: 0, gone: 0, loose: 0, kept: 0, resolver: 0, parse: 0, rejected: 0, filled: 0, nullKept: 0 }; const why = {}
    for (const { src, schema, docs } of kindForms(SEED, COUNT)) {
      const p = planned(schema)
      if (p.why) { tally.refused++; const k = p.why.replace(/^[^:]*: /, ''); why[k] = (why[k] || 0) + 1; continue }
      assert.equal(p.said, null, src)
      const { plan, validate } = p
      tally.taken++; if (plan.kinds.nulls) tally.nulls++; if (plan.kinds.defaults) tally.defaults++; if (plan.kinds.missing) tally.missing++; if (plan.kinds.loose) tally.loose++
      for (const raw of [false, true]) {
        const mine = RT.resolver({ validate }, plan.table, plan.paths, { raw }, plan.refines, plan.fns)
        const theirs = zodResolver(schema, undefined, { raw })
        for (const d of docs) for (const o of OPTS) {
          const want = await theirs(clone(d), undefined, o)
          assert.equal(show(await mine(clone(d), undefined, o)), show(want), `${src}\non ${show(d)} with ${JSON.stringify(o)}, raw ${raw}`)
          tally.resolver++
        }
      }
      if (parseRefusal(plan)) continue
      const mine = RT.schema({ validate }, plan.table, plan.paths, plan.refines, plan.fns)
      for (const d of [...docs, ...ROOTS]) {
        const theirs = schema.safeParse(clone(d)); const got = mine.safeParse(clone(d))
        const want = read(theirs)
        assert.equal(show(read(got)), show(want), `${src}\non ${show(d)}`)
        if (!want.success) { tally.rejected++; if (want.issues.some((i) => /expected nonoptional/.test(i.message))) tally.gone++; assert.equal(show(RT.flat(got.error)), show(theirs.error.flatten()), `flatten on ${show(d)}`) } else {
          // A default written in, and a null handed back as it came.
          const text = show(want.data)
          if (text !== show(d) && plan.kinds.defaults) tally.filled++
          if (text.includes('null')) tally.nullKept++
          if (plan.kinds.loose && /"(?:extra|more|zz|inherited)"/.test(text)) tally.kept++
        }
        tally.parse++
      }
    }
    if (process.env.ZOD_FORMS_SEED || process.env.ZOD_KINDS_REPORT) console.log(`seed ${SEED}: ${JSON.stringify(tally)}\nrefusals ${JSON.stringify(why)}`)
    assert.ok(tally.taken >= COUNT * 0.6, `only ${tally.taken} of ${COUNT} forms were taken (${JSON.stringify(why)})`)
    assert.ok(tally.nulls >= COUNT * 0.3 && tally.defaults >= COUNT * 0.2, JSON.stringify(tally))
    assert.ok(tally.rejected > tally.parse / 3 && tally.rejected < tally.parse, JSON.stringify(tally))
    assert.ok(tally.filled >= 100 && tally.nullKept >= 100, JSON.stringify(tally))
    assert.ok(tally.missing >= 10 && tally.gone >= 50, JSON.stringify(tally))
    assert.ok(tally.loose >= COUNT * 0.2 && tally.kept >= 100, JSON.stringify(tally))
  })
  it('answers as zod on each kind by hand: a missing key, undefined, null and a wrong type', () => {
    const SRC = `z.object({
      n: z.string().min(2, 'Two').nullable(), ns: z.string().nullish(), on: z.number().int().optional().nullable(), e: z.enum(['a', 'b']).nullable(),
      o: z.object({ a: z.string(), b: z.boolean().nullable() }).nullable(), l: z.array(z.string().nullable()).nullable(),
      d: z.string().default('x'), dn: z.number().nullable().default(null), od: z.boolean().optional().default(false), dopt: z.enum(['a', 'b']).default('a').optional(), dl: z.array(z.string()).default([]),
      c: z.coerce.number().nullable(), cd: z.coerce.number().default(3), any: z.any(), unk: z.unknown(), oany: z.any().optional(), nunk: z.unknown().nullable(),
    })`
    const schema = new Function('z', `return ${SRC}`)(z)
    const p = planned(schema)
    assert.equal(p.why, undefined); assert.equal(p.said, null)
    assert.deepEqual(p.plan.kinds, { nulls: true, defaults: true, missing: true })
    assert.deepEqual(p.plan.json.required, ['n', 'e', 'o', 'l', 'c'])
    const mine = RT.schema({ validate: p.validate }, p.plan.table, p.plan.paths, p.plan.refines, p.plan.fns)
    const ok = { n: 'ab', ns: 'a', on: 1, e: 'a', o: { a: 'x', b: true }, l: ['a', null], d: 'y', dn: 2, od: true, dopt: 'b', dl: ['q'], c: '4', cd: '5', any: 1, unk: 'u', oany: {}, nunk: [] }
    const docs = [ok, {}, { n: null, o: null, l: null, c: null, any: undefined, unk: undefined }, { n: null, o: null, l: null, c: null }, { n: null, o: null, l: null, c: null, any: null, unk: null, ns: null, on: null, e: null, dn: null, nunk: null }]
    for (const k of Object.keys(ok)) { const gone = { ...ok }; delete gone[k]; docs.push(gone); for (const v of [undefined, null, 'a', '', 1, 0.5, true, [], {}, [1], { a: 1 }]) docs.push({ ...ok, [k]: v }) }
    for (const v of [undefined, null, 1]) docs.push({ ...ok, o: { a: 'x', b: v } }, { ...ok, o: { a: v } }, { ...ok, l: [v, 'a'] })
    let passed = 0
    for (const d of docs) { const want = read(schema.safeParse(clone(d))); assert.equal(show(read(mine.safeParse(clone(d)))), show(want), `on ${show(d)}`); if (want.success) passed++ }
    assert.ok(passed >= 30 && passed < docs.length - 30, `${passed} of ${docs.length} passed`)
    // What zod does, written down once: a default fills a missing key and
    // one that holds undefined, null stays null, any() needs its key.
    const bare = { n: null, e: null, o: null, l: null, c: null, any: undefined, unk: 0, nunk: null }
    assert.equal(show(mine.safeParse(bare)), show({ success: true, data: { n: null, e: null, o: null, l: null, d: 'x', dn: null, od: false, dopt: 'a', dl: [], c: null, cd: 3, any: undefined, unk: 0, nunk: null } }))
    assert.equal(show(read(mine.safeParse(bare))), show(read(schema.safeParse(bare))))
    delete bare.any; delete bare.unk
    assert.deepEqual(mine.safeParse(bare).error.issues, [{ code: 'invalid_type', path: ['any'], message: 'Invalid input: expected nonoptional, received undefined' }, { code: 'invalid_type', path: ['unk'], message: 'Invalid input: expected nonoptional, received undefined' }])
    assert.equal(show(read(mine.safeParse(bare))), show(read(schema.safeParse(bare))))
    // A default is a copy for each answer, as zod's is.
    const full = { ...bare, any: 1, unk: 1 }
    assert.notEqual(mine.safeParse(full).data.dl, mine.safeParse(full).data.dl)
    assert.notEqual(schema.safeParse(full).data.dl, schema.safeParse(full).data.dl)
    // One that is handed back as it is (under any()) too: changing an answer
    // does not change the next.
    const held = z.object({ a: z.any().default({ n: 1 }), l: z.unknown().default(['x']) })
    const hp = planned(held)
    assert.equal(hp.why, undefined); assert.equal(hp.said, null)
    const hm = RT.schema({ validate: hp.validate }, hp.plan.table, hp.plan.paths, hp.plan.refines, hp.plan.fns)
    for (const s of [held, hm]) { const first = s.safeParse({}).data; first.a.n = 2; first.l.push('y'); assert.deepEqual(s.safeParse({}).data, { a: { n: 1 }, l: ['x'] }) }
  })
  it('the build-time check notices a kind that is carried wrongly', () => {
    const schema = z.object({ n: z.string().min(2).nullable(), o: z.object({ a: z.string() }).nullish(), d: z.string().default('x'), dl: z.array(z.number()).default([1]), any: z.any(), q: z.number().nullish() })
    for (const parse of [false, true]) {
      const plan = planZod(schema)
      const check = () => { const v = new ata.Validator(plan.json, { richErrors: false }); try { return selfCheck(schema, plan, (d) => v.validate(d), parse) } catch (e) { return String(e) } }
      assert.equal(check(), null)
      for (const breakIt of [
        () => { plan.json.properties.n.type = 'string' }, () => { plan.json.properties.o.type = 'object' }, () => { plan.json.required.push('q') }, () => { plan.json.required = [] },
        () => { plan.paths['/d'].d = 'y' }, () => { delete plan.paths['/d'].d }, () => { plan.paths['/dl'].d = [] }, () => { delete plan.paths['/any'].m }, () => { plan.paths['/any'].m[1] = 'gone' }, () => { delete plan.paths[''].y },
        () => { plan.json.properties.q.type = ['number', 'null', 'string'] }, () => { plan.json.properties.any = { type: 'string' } }, () => { plan.json.required.push('any') }, () => { delete plan.paths[''].p },
      ]) {
        const keep = JSON.stringify(plan)
        breakIt()
        assert.notEqual(check(), null, String(breakIt))
        for (const k of Object.keys(plan.paths)) delete plan.paths[k]
        Object.assign(plan, JSON.parse(keep), { fns: plan.fns })
      }
      assert.equal(check(), null)
    }
  })
  it('reads a key named __proto__ as a key, where the document is copied for a rewrite or a default', () => {
    // JSON.parse writes such a key as the object's own. Copied by
    // assignment it became the copy's prototype, and a field missing from the
    // document was then read from it: a number handed back for an optional
    // string.
    for (const schema of [z.object({ a: z.string().trim(), b: z.string().optional() }), z.object({ a: z.string().default('x'), b: z.string().optional() }), z.object({ a: z.coerce.number(), b: z.object({ c: z.string().optional() }) }), z.looseObject({ a: z.string(), b: z.looseObject({ c: z.string().optional() }).optional() }), z.looseObject({ a: z.string().trim(), b: z.unknown().optional() })]) {
      const p = planned(schema)
      assert.equal(p.why, undefined); assert.equal(p.said, null)
      const mine = RT.schema({ validate: p.validate }, p.plan.table, p.plan.paths, p.plan.refines, p.plan.fns)
      for (const text of ['{"a":" x ","__proto__":{"b":1}}', '{"a":"1","b":{"__proto__":{"c":1}},"__proto__":{"b":1}}', '{"__proto__":{"a":"x","b":"y"}}', '{"a":"3","b":{"c":"x","__proto__":{"c":2}}}']) {
        const want = read(schema.safeParse(JSON.parse(text))); const got = read(mine.safeParse(JSON.parse(text)))
        assert.equal(show(got), show(want), text)
        if (got.success) { const theirs = schema.safeParse(JSON.parse(text)).data; assert.equal(Object.getPrototypeOf(got.data), Object.prototype); assert.deepEqual(Object.getOwnPropertyNames(got.data), Object.getOwnPropertyNames(theirs)); if (got.data.b && typeof got.data.b === 'object') { assert.equal(Object.getPrototypeOf(got.data.b), Object.getPrototypeOf(theirs.b)); assert.deepEqual(Object.getOwnPropertyNames(got.data.b), Object.getOwnPropertyNames(theirs.b)) } }
      }
    }
  })
  it('words a number that is not finite as the application\'s zod does', () => {
    // 4.2.1 and 4.3.6 say `received number` for Infinity, 4.6.7 `received
    // Infinity`. The plan asks the schema, and the page's text follows.
    const schema = z.object({ a: z.string(), n: z.number().nullable() })
    const plan = planZod(schema)
    const named = schema.safeParse(Infinity).error.issues[0].message === 'Invalid input: expected object, received Infinity'
    assert.equal(!!plan.kinds.number, !named)
    const now = zodRuntimeFor(false, false, false, true, true, false); const earlier = zodRuntimeFor(false, false, false, true, true, false, { number: true })
    assert.match(now, /Number\.isFinite\(v\) \? 'number' : String\(v\)/)
    assert.equal(earlier, now.replace("Number.isFinite(v) ? 'number' : String(v)", "'number'"))
    assert.ok(earlier.length < now.length)
    // The earlier wording, run: what the page would say under such a zod.
    const v = new ata.Validator(plan.json, { richErrors: false })
    const old = zodRuntime(null, null, null, { number: true }).schema({ validate: (d) => v.validate(d) }, plan.table, plan.paths, plan.refines, plan.fns)
    assert.deepEqual(old.safeParse({ a: Infinity, n: -Infinity }).error.issues.map((i) => i.message), ['Invalid input: expected string, received number', 'Invalid input: expected number, received number'])
    assert.deepEqual(old.safeParse({ a: NaN, n: null }).error.issues.map((i) => i.message), ['Invalid input: expected string, received NaN'])
  })
  it('writes the lines of a kind only into a file that has it', () => {
    const base = zodRuntimeFor(true, true, true, true, true, true)
    assert.equal(zodRuntimeFor(true, true, true, true, true, true, {}), base)
    assert.doesNotMatch(base, /n\.l\b|'d' in |n\.n\b|__ataZMissing|c\.m\b|v === null\) return v/)
    const sizes = {}
    for (const k of ['nulls', 'defaults', 'missing', 'loose']) { const text = zodRuntimeFor(true, true, true, true, true, true, { [k]: true }); assert.ok(text.length > base.length, k); sizes[k] = text.length - base.length }
    assert.match(zodRuntimeFor(false, false, false, true, false, false, { nulls: true }), /v === null\) return v/)
    assert.doesNotMatch(zodRuntimeFor(false, false, false, true, false, false, { nulls: true }), /const __ataZPrep|const __ataZRefine/)
    assert.match(zodRuntimeFor(true, false, false, true, false, false, { defaults: true }), /'d' in n/)
    assert.match(zodRuntimeFor(false, false, false, true, false, false, { missing: true }), /__ataZMissing/)
  })
})

// The same forms as files: a build replaces each zodResolver call and each
// schema's safeParse, and the bundle it writes answers as zod on every
// document. This is the module the page runs, not the check the build used.
const READ = `(s) => (d) => { const r = s.safeParse(d); return r.success ? { success: true, data: r.data } : { success: false, issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })) } }`
const fileOf = (taken) => `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst read = ${READ}\n` + taken.map((f, i) => `const r${i} = ${f.src}\nexport const R${i} = zodResolver(r${i})\nconst p${i} = ${f.src}\nexport const P${i} = (d) => { const r = p${i}.safeParse(d); return r.success ? { success: true, data: r.data } : { success: false, issues: r.error.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })) } }\n`).join('')
const takenForms = (n) => { const out = []; for (const f of kindForms(SEED, COUNT)) { const p = planned(f.schema); if (!p.why && p.said === null && !parseRefusal(p.plan)) out.push(f); if (out.length === n) break } return out }
const HAS_ZOD = /ZodError|_zod\b/
const sameAsZod = async (mod, taken) => {
  let answers = 0
  for (const [i, f] of taken.entries()) {
    const theirs = zodResolver(f.schema)
    for (const d of f.docs) {
      for (const o of OPTS) assert.equal(show(await mod[`R${i}`](clone(d), undefined, o)), show(await theirs(clone(d), undefined, o)), `${f.src}\nresolver on ${show(d)}`)
      assert.equal(show(mod[`P${i}`](clone(d))), show(read(f.schema.safeParse(clone(d)))), `${f.src}\nsafeParse on ${show(d)}`)
      answers += 3
    }
    for (const d of ROOTS) assert.equal(show(mod[`P${i}`](clone(d))), show(read(f.schema.safeParse(clone(d)))), `${f.src}\nsafeParse on ${show(d)}`)
  }
  return answers
}

describe('zod kinds compiled away: a build', () => {
  let dir
  before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'zod-kinds-')) })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })
  let n = 0
  const build = async (source, options = {}) => {
    const esbuild = await import('esbuild')
    const root = path.join(dir, 'b' + n++)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'page.js'), source)
    const out = path.join(root, 'dist', 'page.out.mjs')
    const log = []
    const logger = { info: (m) => log.push(m), warn: (m) => log.push(m) }
    await esbuild.build({ absWorkingDir: root, entryPoints: ['page.js'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', plugins: [esbuildPlugin({ verify: false, logger, ...options })] })
    return { text: await fs.readFile(out, 'utf8'), mod: await import(pathToFileURL(out).href), log }
  }
  for (const [name, options] of [['each schema its own checks', { table: false }], ['plans for one interpreter', { table: true }]]) {
    it(`a bundle answers as zod on forty generated forms, zod out of it: ${name}`, async () => {
      const taken = takenForms(40)
      assert.equal(taken.length, 40)
      const { text, mod, log } = await build(fileOf(taken), options)
      assert.doesNotMatch(text, HAS_ZOD, 'zod is still in the bundle\n' + log.join('\n'))
      assert.equal((text.match(/__ataZodResolver\(/g) || []).length, 40, log.join('\n'))
      assert.ok(log.some((l) => /zodResolver: 40 of 40 calls compiled/.test(l)) && log.some((l) => /safeParse: 40 of 40 zod schemas compiled/.test(l)), log.join('\n'))
      assert.ok(await sameAsZod(mod, taken) > 5000)
    })
  }
  it('a page without these kinds carries none of their lines, and one with a kind carries only that one', async () => {
    const page = (field) => `import { z } from 'zod'\nconst s = z.object({ a: ${field} })\nexport const ok = (d) => s.safeParse(d).success\n`
    const KIND = /__ataZMissing|"d" in |v === null\) return v|\.n\) (?:continue|return)/
    const plain = (await build(page('z.string().min(2)'))).text
    assert.doesNotMatch(plain, HAS_ZOD)
    assert.doesNotMatch(plain, KIND)
    const nulls = (await build(page('z.string().min(2).nullable()'))).text
    assert.doesNotMatch(nulls, HAS_ZOD)
    assert.match(nulls, /v === null\) return v/); assert.doesNotMatch(nulls, /__ataZMissing|"d" in |__ataZPrep = /)
    const filled = (await build(page("z.string().default('x')"))).text
    assert.match(filled, /"d" in /); assert.doesNotMatch(filled, /__ataZMissing|v === null\) return v/)
    // zod 4.6.7 reports the key of an unknown() where it is absent; 4.2.1
    // and 4.3.6 do not, and a build on those writes no part for it.
    const any = (await build(page('z.unknown()'))).text
    const needsKey = !z.object({ a: z.unknown() }).safeParse({}).success
    assert.doesNotMatch(any, HAS_ZOD)
    if (needsKey) assert.match(any, /__ataZMissing/); else assert.doesNotMatch(any, /__ataZMissing/)
    assert.doesNotMatch(any, /"d" in |v === null\) return v/)
    assert.ok(nulls.length - plain.length < 200 && plain.length < nulls.length, `${plain.length} ${nulls.length}`)
  })
  it('keeps zod for a default the field would not pass, a check after nullable(), and catch(), and says why', async () => {
    const page = (field) => `import { z } from 'zod'\nconst s = z.object({ a: ${field} })\nexport const ok = (d) => s.safeParse(d).success\n`
    for (const [field, why] of [["z.string().min(3).default('x')", /a default the field itself would refuse or rewrite is not carried/], ["z.string().nullable().refine((v) => v !== 'x')", /a check written after nullable\(\) is not carried/], ["z.string().catch('x')", /takes a missing value without being optional/], ['z.array(z.string().nullish())', /an array of optional items is not carried/]]) {
      const { text, log } = await build(page(field))
      assert.match(text, HAS_ZOD, field)
      assert.ok(log.some((l) => why.test(l)), field + '\n' + log.join('\n'))
    }
  })
})

// The same forms through the 2.0 core: ATA_V2_TEST names a checkout of it,
// copied into the fixture's node_modules, and the module compile-away writes
// from it is imported and held to zod. Without ATA_V2_TEST this is skipped.
const V2 = process.env.ATA_V2_TEST || null
const skipV2 = V2 && fss.existsSync(path.join(V2, 'lib/ir/index.mjs')) ? false : 'set ATA_V2_TEST to an ata-validator checkout'
describe('zod kinds compiled away: the 2.0 core', { skip: skipV2 }, () => {
  let dir; let api
  before(async () => {
    dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-zod-kinds-v2-'))
    const dest = path.join(dir, 'node_modules', 'ata-validator')
    fss.mkdirSync(dest, { recursive: true })
    for (const e of fss.readdirSync(V2, { withFileTypes: true })) {
      if (e.isDirectory() ? !['lib', 'bin', 'features'].includes(e.name) : !/^(package\.json|.*\.(m?js|cjs|d\.ts))$/.test(e.name)) continue
      fss.cpSync(path.join(V2, e.name), path.join(dest, e.name), { recursive: true })
    }
    const req = createRequire(path.join(dest, 'x.js'))
    const b = req('./build.js')
    api = { ...ata, Validator: req('./index.js').Validator, ir: await import(pathToFileURL(path.join(dest, 'lib/ir/index.mjs')).href), kernelsUrl: pathToFileURL(path.join(dest, 'lib/kernels/index.mjs')).href, compiledOptions: b.compiledOptions, compiledBuildOptions: b.compiledBuildOptions, compiledModuleFor: b.compiledModuleFor, compiledSchemaFor: b.compiledSchemaFor, defaultsSource: b.defaultsSource, verify: b.verify }
  })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })
  for (const table of [false, true]) {
    it(`the module written from the 2.0 core answers as zod on forty generated forms${table ? ', as plans' : ''}`, async () => {
      const taken = takenForms(40)
      const file = path.join(dir, `page-${table}.mjs`)
      const kept = []
      const out = compileAway(fileOf(taken), file, api, { ir: true, table, zodResolver: true, zodSafeParse: true, kept })
      assert.deepEqual(kept, [])
      assert.equal(out.zod, 40); assert.equal(out.zodParse, 40)
      assert.doesNotMatch(out.code, /from ['"]zod['"]/)
      await fs.writeFile(file, out.code)
      assert.ok(await sameAsZod(await import(pathToFileURL(file).href), taken) > 5000)
    })
  }
})
