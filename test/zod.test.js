// The `zod` option: a module of zod schemas, read at build time and written
// as validators a page's build compiles away. The page must give zod's
// verdict on every document, unknown keys included, and a schema the
// conversion would silently loosen must stop the build by name.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileZod, unrepresentable } from '../src/zod.js'
import { compileAway } from '../src/compile-away.js'
import { __internal, compile } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
let dir
before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-zod-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const MODULE = `import { z } from 'zod'
export const widgetEvent = z.object({
  event: z.enum(['view', 'click']),
  widgetId: z.string().min(1),
  position: z.number().int().min(0),
  label: z.string().optional(),
})
export const strictEvent = z.strictObject({ id: z.string().uuid(), n: z.number() })
export const anyEvent = z.union([widgetEvent, z.object({ ping: z.literal(true) })])
export const notASchema = { event: 'view' }
`
const DOCS = [
  { event: 'click', widgetId: 'w1', position: 3 },
  { event: 'click', widgetId: 'w1', position: 3, extra: 'unknown', nested: { a: 1 } },
  { event: 'hover', widgetId: '', position: -1 },
  { event: 'view', widgetId: 'w', position: 1.5 },
  { id: '3b241101-e2bb-4255-8caf-4136c566a962', n: 1 },
  { id: '3b241101-e2bb-4255-8caf-4136c566a962', n: 1, extra: true },
  { ping: true }, { ping: false }, {}, null, 'x', [],
]
const write = async (f, s) => { await fs.writeFile(f, s); return true }
const files = (globs, root) => __internal.resolveSchemaFiles(globs, root)
const load = (f) => import(pathToFileURL(f).href + `?t=${Date.now()}`)

describe('zod', () => {
  it('writes one validators module per zod module, one export per schema, and types', async () => {
    const file = path.join(dir, 'widget.mjs')
    await fs.writeFile(file, MODULE)
    const r = await compileZod('widget.mjs', dir, write, files, load, null)
    // A module namespace lists its exports in alphabetical order, so the
    // generated file is stable whatever the source's order.
    assert.deepEqual(r[0].exports, ['anyEvent', 'strictEvent', 'widgetEvent'])
    const src = await fs.readFile(path.join(dir, 'widget.validators.mjs'), 'utf8')
    assert.equal((src.match(/new Validator\(/g) || []).length, 3)
    assert.equal((src.match(/"richErrors":false/g) || []).length, 3, 'plain errors by default')
    assert.ok(src.includes('"pattern":"^([0-9a-fA-F]{8}-') && !src.includes('"format":"uuid"'), 'zod\'s regex stands alone, no format beside it')
    assert.ok(!src.includes('"additionalProperties":false,"properties":{"event"') && !src.includes('"properties":{"event"') || src.includes('"required":["event","widgetId","position"]'), 'the input schema is written')
    const dts = await fs.readFile(path.join(dir, 'widget.validators.d.mts'), 'utf8')
    assert.match(dts, /export declare const widgetEvent: \{ validate\(data: unknown\): Result<WidgetEventInput>/)
    assert.match(dts, /export declare namespace StrictEvent \{/)
  })

  it('an unknown key passes as it passes z.object, and the page gives zod verdicts on every document', async () => {
    const zod = await load(path.join(dir, 'widget.mjs'))
    const src = await fs.readFile(path.join(dir, 'widget.validators.mjs'), 'utf8')
    const server = await load(path.join(dir, 'widget.validators.mjs'))
    const out = compileAway(src, path.join(dir, 'widget.validators.mjs'), ata, { ir: true })
    assert.ok(out && !out.code.includes('new Validator('), 'every validator is compiled for the page')
    const pageFile = path.join(dir, 'page.mjs'); await fs.writeFile(pageFile, out.code)
    const page = await load(pageFile)
    let checks = 0
    for (const name of ['widgetEvent', 'strictEvent', 'anyEvent']) for (const d of DOCS) {
      const want = zod[name].safeParse(structuredClone(d)).success
      assert.equal(page[name].isValidObject(structuredClone(d)), want, `${name} page verdict on ${JSON.stringify(d)}`)
      assert.equal(server[name].validate(structuredClone(d)).valid, want, `${name} server verdict on ${JSON.stringify(d)}`)
      checks++
    }
    assert.equal(checks, 3 * DOCS.length)
    // Errors carry the field's path and a message.
    const r = page.widgetEvent.validate({ event: 'hover', widgetId: '', position: -1 })
    assert.equal(r.valid, false)
    assert.deepEqual(r.errors.map((e) => e.instancePath), ['/event', '/widgetId', '/position'])
    assert.ok(r.errors.every((e) => typeof e.message === 'string' && e.message.length))
    // The strict object stays closed; the plain one does not strip, it passes.
    assert.equal(page.strictEvent.isValidObject({ id: '3b241101-e2bb-4255-8caf-4136c566a962', n: 1, extra: true }), false)
    const open = { event: 'view', widgetId: 'w', position: 0, extra: 1 }
    assert.equal(page.widgetEvent.isValidObject(open), true)
    assert.equal('extra' in open, true)
  })

  it('a TypeScript module goes through jiti', async () => {
    const file = path.join(dir, 'events.ts')
    await fs.writeFile(file, `import { z } from 'zod'\nexport const click = z.object({ x: z.number(), y: z.number() })\nexport type Click = z.infer<typeof click>\n`)
    const r = await compile({ zod: 'events.ts', schemas: 'none/**/*.schema.json', root: dir })
    const zodResult = r.results.find((x) => x.zod)
    assert.deepEqual(zodResult.zod.exports, ['click'])
    const page = await load(path.join(dir, 'events.validators.mjs'))
    assert.equal(page.click.validate({ x: 1, y: 2 }).valid, true)
    assert.equal(page.click.validate({ x: 1 }).valid, false)
  })

  it('a refine or transform stops the build by export and path; dropRefinements takes them out knowingly', async () => {
    const file = path.join(dir, 'refined.mjs')
    await fs.writeFile(file, `import { z } from 'zod'\nexport const signup = z.object({ email: z.string().email().refine((v) => !v.endsWith('@example.com'), 'no example'), name: z.string().transform((v) => v.trim()), tags: z.array(z.string().refine((t) => t.length < 10)) })\n`)
    const found = unrepresentable((await load(file)).signup)
    assert.deepEqual(found, ['$.email: refine', '$.name: transform', '$.tags[]: refine'])
    await assert.rejects(() => compileZod('refined.mjs', dir, write, files, load, null), /refined\.mjs export signup: \$\.email: refine, \$\.name: transform, \$\.tags\[\]: refine/)
    const warnings = []
    const r = await compileZod({ files: 'refined.mjs', dropRefinements: true }, dir, write, files, load, { warn: (m) => warnings.push(m) })
    assert.deepEqual(r[0].exports, ['signup'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /dropped \$\.email: refine/)
  })

  it('a module with no zod export, or a zod type JSON Schema cannot carry, is refused', async () => {
    await fs.writeFile(path.join(dir, 'plain.mjs'), 'export const a = { type: "object" }\n')
    await assert.rejects(() => compileZod('plain.mjs', dir, write, files, load, null), /exports no zod schema/)
    await fs.writeFile(path.join(dir, 'dated.mjs'), `import { z } from 'zod'\nexport const when = z.object({ at: z.date() })\n`)
    await assert.rejects(() => compileZod('dated.mjs', dir, write, files, load, null), /dated\.mjs export when: /)
  })

  it('the page bundle carries neither zod nor a validator runtime, and is small', async () => {
    const esbuild = await import('esbuild')
    const src = await fs.readFile(path.join(dir, 'widget.validators.mjs'), 'utf8')
    const out = compileAway(src, path.join(dir, 'widget.validators.mjs'), ata, { ir: true })
    const pageFile = path.join(dir, 'page-bundle.mjs'); await fs.writeFile(pageFile, out.code + '\nexport const check = (d) => widgetEvent.isValidObject(d)\n')
    const zodFile = path.join(dir, 'zod-bundle.mjs'); await fs.writeFile(zodFile, `import { widgetEvent } from './widget.mjs'\nexport const check = (d) => widgetEvent.safeParse(d).success\n`)
    const sizes = {}
    for (const [name, entry] of [['ata', pageFile], ['zod', zodFile]]) {
      const b = await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent', absWorkingDir: here })
      const text = b.outputFiles[0].text
      sizes[name] = gzipSync(text, { level: 9 }).length
      if (name === 'ata') { assert.ok(!/new Function|zod|interpreter/.test(text), 'no zod and no runtime in the page bundle') }
    }
    console.log(`    page bundle, gzipped: ata ${sizes.ata} B, zod ${sizes.zod} B (zod ${(await import('zod/package.json', { with: { type: 'json' } })).default.version})`)
    // Measured 3930 B: three schemas, one of them a union of objects, plain errors.
    assert.ok(sizes.ata < 4500, `the compiled page is small (${sizes.ata} B)`)
    assert.ok(sizes.zod > sizes.ata * 5, 'zod itself is what the page sheds')
  })
})
