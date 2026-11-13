// compile() holds each validators file against the library its schemas are
// written in, before it writes it: documents made from the JSON Schema go to
// zod's own check and to the written validator, and a difference in verdict
// stops the build with the document. The check found, on its first run,
// three things the conversion dropped without a word; each is refused by
// name now, and tested here:
//   - `z.string().trim().min(1)`: the page accepted "  " (zod trims, then
//     counts);
//   - `z.coerce.number()`: the page refused "5";
//   - `z.number().catch(1)`: the page refused anything but a number.
// `check: true` writes nothing and lists the files a compile would change.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile, __internal } from '../src/core.js'
import { agreement, compileZod } from '../src/zod.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
const can = !!(ata && ata.verify && typeof ata.verify.generate === 'function' && ata.compiledModuleFor)
let dir
before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-verify-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const quiet = { warn: () => {} }
const load = (f) => import(pathToFileURL(f).href + `?t=${Date.now()}`)
const sub = async (name, files) => {
  const root = path.join(dir, name)
  await fs.mkdir(root, { recursive: true })
  for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(root, f), text)
  return root
}

describe('compile() checks the written validators against their source', { skip: can ? false : 'ata-validator with verify is not installed' }, () => {
  it('compares every export on generated documents and reports the count', async () => {
    const root = await sub('ok', { 'a.mjs': `import { z } from 'zod'
export const event = z.object({ kind: z.enum(['view', 'click']), id: z.string().min(1), at: z.number().int().min(0), tags: z.array(z.string()).max(3).optional() })
export const strict = z.strictObject({ id: z.uuid(), n: z.number().gt(0) })
export const either = z.discriminatedUnion('t', [z.object({ t: z.literal('a'), a: z.string() }), z.object({ t: z.literal('b'), b: z.number() })])
` })
    const r = await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet })
    const v = r.results[0].zod.verified
    assert.equal(v.exports, 3)
    assert.ok(v.documents >= 150, `${v.documents} documents`)
    assert.deepEqual(v.disagreements, [])
    assert.deepEqual(r.stale, [])
    const left = (await fs.readdir(root)).filter((f) => f.includes('verify-'))
    assert.deepEqual(left, [], 'the file the check loads is removed')
    const n = await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet, verify: 5 })
    assert.ok(n.results[0].zod.verified.documents < v.documents)
    const off = await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet, verify: false })
    assert.equal(off.results[0].zod.verified, null)
  })

  it('a validator that answers differently stops the build with the document, and nothing is written', async () => {
    const root = await sub('bad', { 'a.mjs': `import { z } from 'zod'\nexport const s = z.object({ n: z.number().min(3) })\n` })
    const mod = await load(path.join(root, 'a.mjs'))
    const base = path.join(root, 'a')
    // A written file that checks nothing stands in for a wrong conversion.
    const wrong = 'export const s = { isValidObject: () => true, validate: () => ({ valid: true, errors: [] }) }\n'
    const schema = { type: 'object', properties: { n: { type: 'number', minimum: 3 } }, required: ['n'] }
    const vendors = { s: { vendor: 'zod', accepts: async () => (sch, d) => sch.safeParse(d).success } }
    const rep = await agreement(path.join(root, 'a.mjs'), base, wrong, mod, { s: schema }, vendors, new Set(), ata.verify.generate, 20)
    assert.ok(rep.disagreements.length > 0 && rep.disagreements.length <= 3)
    assert.equal(rep.disagreements[0].source, false)
    assert.equal(rep.disagreements[0].compiled, true)
    // The same through compileZod: thrown, with the document, before the write.
    const written = []
    await assert.rejects(
      () => compileZod({ files: 'a.mjs' }, root, async (f) => { written.push(f); return true }, (g, r) => __internal.resolveSchemaFiles(g, r), load, null, false, () => wrong, { generate: ata.verify.generate, count: 20 }),
      /a\.mjs: the validators written for this module do not answer as its schemas do[\s\S]*s: zod rejects, the written validator accepts: \{/)
    assert.deepEqual(written, [])
  })

  it('refuses what the conversion would drop: a check after trim, coerce, catch', async () => {
    const root = await sub('refused', {
      'trim.mjs': `import { z } from 'zod'\nexport const a = z.object({ name: z.string().trim().min(1) })\n`,
      'coerce.mjs': `import { z } from 'zod'\nexport const a = z.object({ n: z.coerce.number() })\n`,
      'catch.mjs': `import { z } from 'zod'\nexport const a = z.object({ n: z.number().catch(1) })\n`,
      'union.mjs': `import { z } from 'zod'\nexport const a = z.union([z.string().trim(), z.number()])\n`,
    })
    await assert.rejects(() => compile({ root, schemas: [], zod: ['trim.mjs'], logger: quiet }), /export a: \$\.name: min_length after a rewrite of the value/)
    await assert.rejects(() => compile({ root, schemas: [], zod: ['coerce.mjs'], logger: quiet }), /export a: \$\.n: coerce, which converts the value before checking it/)
    await assert.rejects(() => compile({ root, schemas: [], zod: ['catch.mjs'], logger: quiet }), /export a: \$\.n: catch, which takes any value/)
    await assert.rejects(() => compile({ root, schemas: [], zod: ['union.mjs'], logger: quiet }), /a rewrite of the value \(trim, toLowerCase, normalize\) inside a union or record/)
    // Taken out knowingly, the file is written as before, and that export is
    // not compared: it is known to differ.
    const warned = []
    const r = await compile({ root, schemas: [], zod: [{ files: 'trim.mjs', dropRefinements: true }], logger: { warn: (m) => warned.push(m) } })
    assert.match(warned.join('\n'), /dropped \$\.name: min_length after a rewrite/)
    assert.deepEqual(r.results[0].zod.verified.skipped, ['a: refinements dropped'])
    assert.equal((await load(r.results[0].zod.module)).a.isValidObject({ name: '  ' }), true)
  })

  it('carries a rewrite with nothing checked after it, so data is what zod gives', async () => {
    const root = await sub('carried', { 'a.mjs': `import { z } from 'zod'
export const a = z.object({ name: z.string().min(1).trim(), code: z.string().toLowerCase().refine((v) => v === 'ok', 'not ok'), tags: z.array(z.string().toUpperCase()) })
` })
    const r = await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet })
    assert.deepEqual(r.results[0].zod.verified.disagreements, [])
    const { a } = await load(r.results[0].zod.module)
    const { z } = await import('zod')
    const src = (await load(path.join(root, 'a.mjs'))).a
    for (const d of [{ name: ' x ', code: 'OK', tags: ['q'] }, { name: 'x', code: 'no', tags: [] }, { name: '', code: 'ok', tags: [] }, { name: 'x', code: 'Ok', tags: ['a', 1] }]) {
      const want = src.safeParse(JSON.parse(JSON.stringify(d)))
      const got = a.validate(JSON.parse(JSON.stringify(d)))
      assert.equal(got.valid, want.success, JSON.stringify(d))
      assert.equal(a.isValidObject(JSON.parse(JSON.stringify(d))), want.success, JSON.stringify(d))
      if (want.success) assert.deepEqual(got.data, want.data)
    }
    assert.ok(z)
  })

  it('check: true writes nothing and lists the files a compile would change', async () => {
    const root = await sub('check', { 'a.mjs': `import { z } from 'zod'\nexport const a = z.object({ id: z.string() })\n` })
    const first = await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet, check: true })
    assert.deepEqual(first.stale.map((f) => path.basename(f)), ['a.validators.d.mts', 'a.validators.mjs'])
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.mjs'])
    await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet })
    assert.deepEqual((await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet, check: true })).stale, [])
    // A generated file that no longer matches its schema (edited by hand
    // here; a schema changed without a recompile reads the same).
    const file = path.join(root, 'a.validators.mjs')
    const edited = (await fs.readFile(file, 'utf8')) + '// edited\n'
    await fs.writeFile(file, edited)
    const again = await compile({ root, schemas: [], zod: ['a.mjs'], logger: quiet, check: true })
    assert.deepEqual(again.stale.map((f) => path.basename(f)), ['a.validators.mjs'])
    assert.equal(await fs.readFile(file, 'utf8'), edited)
  })
})
