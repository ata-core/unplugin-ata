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
import unplugin from '../src/index.js'

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
    // The type is zod's own input type, not one written from the schema.
    const dts = await fs.readFile(path.join(dir, 'events.validators.d.mts'), 'utf8')
    assert.match(dts, /export type ClickInput = z\.input<typeof import\("\.\/events\.js"\)\.click>/)
    await fs.writeFile(path.join(dir, 'consumer.ts'), `import { click } from './events.validators.mjs'\ntype Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false\nconst r = click.validate({})\nif (r.valid) { const ok: Equal<typeof r.data, { x: number; y: number }> = true; void ok }\nconst e: string = r.valid ? '' : r.errors[0].instancePath\nvoid e\n`)
    await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', skipLibCheck: true, types: [] }, files: ['consumer.ts'] }))
    const { execFileSync } = await import('node:child_process')
    const tsc = path.join(here, '..', 'node_modules', '.bin', 'tsc')
    let out = ''
    try { out = execFileSync(tsc, ['-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8', stdio: 'pipe' }) } catch (e) { out = String(e.stdout || '') + String(e.stderr || '') }
    assert.equal(out.trim(), '', `the consumer type-checks against zod's own type:\n${out}`)
  })

  it('a refine or transform stops the build by export and path; dropRefinements takes them out knowingly', async () => {
    const file = path.join(dir, 'refined.mjs')
    await fs.writeFile(file, `import { z } from 'zod'\nexport const signup = z.object({ email: z.string().email().refine((v) => !v.endsWith('@example.com'), 'no example'), name: z.string().transform((v) => v.trim()), tags: z.array(z.string().refine((t) => t.length < 10)) })\n`)
    // The two refines read only their parameter and are carried; the
    // transform is what refuses the export.
    const found = unrepresentable((await load(file)).signup)
    assert.deepEqual(found, ['$.name: transform'])
    await assert.rejects(() => compileZod('refined.mjs', dir, write, files, load, null), /refined\.mjs export signup: \$\.name: transform\./)
    const warnings = []
    const r = await compileZod({ files: 'refined.mjs', dropRefinements: true }, dir, write, files, load, { warn: (m) => warnings.push(m) })
    assert.deepEqual(r[0].exports, ['signup'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /dropped \$\.name: transform/)
  })

  it('a refine that reads only its parameter is carried: the page gives zod verdicts, with zod path and message', async () => {
    const file = path.join(dir, 'carried.mjs')
    await fs.writeFile(file, `import { z } from 'zod'
export const signup = z.object({
  email: z.string().email().refine((v) => !v.endsWith('@example.com'), 'no example addresses'),
  password: z.string().min(8).refine((v) => /[0-9]/.test(v) && /[a-z]/.test(v), { message: 'needs a digit and a letter' }),
  tags: z.array(z.string().refine((t) => t.length < 10)).optional(),
  dates: z.object({ from: z.string(), to: z.string() }).refine((d) => d.from <= d.to, { message: 'from after to', path: ['to'] }),
}).refine((o) => o.email !== o.password, 'password equals email')
`)
    const r = await compileZod('carried.mjs', dir, write, files, load, null)
    assert.deepEqual(r[0].exports, ['signup'])
    const src = await fs.readFile(path.join(dir, 'carried.validators.mjs'), 'utf8')
    assert.ok(src.includes("(v) => !v.endsWith('@example.com')") && src.includes('function refined('), 'the refine text and the runner are in the module')
    const zod = await load(file)
    const out = compileAway(src, path.join(dir, 'carried.validators.mjs'), ata, { ir: true })
    assert.ok(out && !out.code.includes('new Validator('), 'the validator is compiled for the page')
    const pageFile = path.join(dir, 'carried-page.mjs'); await fs.writeFile(pageFile, out.code)
    const page = await load(pageFile)
    const base = { email: 'a@b.co', password: 'abc12345', dates: { from: '2026-01-01', to: '2026-02-01' } }
    const docs = [base, { ...base, email: 'x@example.com' }, { ...base, password: 'abcdefgh' }, { ...base, password: 'ab1@b.com', email: 'ab1@b.com' }, { ...base, tags: ['ok', 'this one is too long'] }, { ...base, tags: ['ok'] }, { ...base, dates: { from: '2026-03-01', to: '2026-02-01' } }, { ...base, password: 'short' }, { email: 'a@b.co' }, {}, 5]
    let checks = 0
    for (const d of docs) {
      const want = zod.signup.safeParse(structuredClone(d)).success
      assert.equal(page.signup.isValidObject(structuredClone(d)), want, `verdict on ${JSON.stringify(d)}`)
      assert.equal(page.signup.validate(structuredClone(d)).valid, want, `validate on ${JSON.stringify(d)}`)
      checks++
    }
    assert.equal(checks, docs.length)
    const e1 = page.signup.validate({ ...base, email: 'x@example.com' }).errors
    assert.deepEqual(e1.map((e) => [e.instancePath, e.message, e.keyword]), [['/email', 'no example addresses', 'refine']])
    const e2 = page.signup.validate({ ...base, dates: { from: '2026-03-01', to: '2026-02-01' } }).errors
    assert.deepEqual(e2.map((e) => [e.instancePath, e.message]), [['/dates/to', 'from after to']])
    const e3 = page.signup.validate({ ...base, tags: ['ok', 'this one is too long'] }).errors
    assert.deepEqual(e3.map((e) => [e.instancePath, e.message]), [['/tags/1', 'Invalid input']])
    const e4 = page.signup.validate({ ...base, password: 'ab1@b.com', email: 'ab1@b.com' }).errors
    assert.deepEqual(e4.map((e) => [e.instancePath, e.message]), [['', 'password equals email']])
  })

  it('a refine that closes over an outside name, or stands inside a union, is refused by path', async () => {
    const file = path.join(dir, 'closed.mjs')
    await fs.writeFile(file, `import { z } from 'zod'\nconst MAX = 9\nexport const a = z.object({ n: z.string().refine((v) => v.length < MAX) })\nexport const b = z.union([z.string().refine((v) => v !== 'x'), z.number()])\n`)
    await assert.rejects(() => compileZod('closed.mjs', dir, write, files, load, null), /export a: \$\.n: refine closes over MAX/)
    const mod = await load(file)
    assert.deepEqual(unrepresentable(mod.b), ['$|0: refine inside a union or record, which a page cannot place'])
  })

  it('a module with no zod export, or a zod type JSON Schema cannot carry, is refused', async () => {
    await fs.writeFile(path.join(dir, 'plain.mjs'), 'export const a = { type: "object" }\n')
    await assert.rejects(() => compileZod('plain.mjs', dir, write, files, load, null), /exports no zod schema/)
    await fs.writeFile(path.join(dir, 'dated.mjs'), `import { z } from 'zod'\nexport const when = z.object({ at: z.date() })\n`)
    await assert.rejects(() => compileZod('dated.mjs', dir, write, files, load, null), /dated\.mjs export when: /)
  })

  // The setup the option is for: a fragment built by Rspack, zod source in
  // the repository, the plugin's zod pass in the build.
  it('an Rspack fragment built with the zod option carries neither zod nor a runtime', async () => {
    const { rspack } = await import('@rspack/core')
    const fragment = path.join(dir, 'fragment.mjs')
    await fs.writeFile(fragment, `import { widgetEvent } from './widget.validators.mjs'\nexport const check = (d) => widgetEvent.isValidObject(d)\nexport const errors = (d) => widgetEvent.validate(d).errors\n`)
    const out = path.join(dir, 'rspack-out')
    await new Promise((resolve, reject) => {
      rspack({
        mode: 'production', context: dir, entry: fragment,
        experiments: { outputModule: true },
        output: { path: out, filename: 'fragment.out.mjs', library: { type: 'module' } },
        plugins: [unplugin.rspack({ zod: 'widget.mjs', schemas: 'none/**/*.schema.json' })],
      }, (err, stats) => { if (err) return reject(err); if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true, all: false }))); resolve() })
    })
    const built = await fs.readFile(path.join(out, 'fragment.out.mjs'), 'utf8')
    assert.doesNotMatch(built, /from\s+['"]ata-validator|require\(['"]ata-validator/, 'the fragment imports no runtime')
    assert.doesNotMatch(built, /zod|safeParse|new Function/, 'the fragment carries no zod')
    const mod = await load(path.join(out, 'fragment.out.mjs'))
    assert.equal(mod.check({ event: 'click', widgetId: 'w1', position: 3, extra: 1 }), true)
    assert.equal(mod.check({ event: 'hover', widgetId: '', position: -1 }), false)
    assert.deepEqual(mod.errors({ event: 'hover', widgetId: '', position: -1 }).map((e) => e.instancePath), ['/event', '/widgetId', '/position'])
    console.log(`    rspack fragment, gzipped: ${gzipSync(built, { level: 9 }).length} B`)
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
