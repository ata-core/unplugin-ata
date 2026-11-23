// A zodResolver or safeParse call is left as written where zod stays on the
// page through a module the file still imports (src/compile-away.js
// compileAway and runtimeImports, src/first-load.js zodThrough). One build
// per cause found in real applications: an env module, a registry of
// components, a module of schemas and constants. Each claim is read from the
// bundle esbuild wrote: whether zod is in it, and whether the compiled form is.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuildPlugin from '../src/esbuild.js'
import { compileAway, runtimeImports } from '../src/compile-away.js'
import { zodThrough } from '../src/first-load.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()

const SCHEMA = `z.object({ name: z.string().min(2), email: z.email() })`
const FORM = (extra = '') => `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\n${extra}const schema = ${SCHEMA}\nexport const resolver = zodResolver(schema)\n`
// The stand-in for @t3-oss/env-nextjs: it parses with the schemas it is given.
const T3 = `export const createEnv = (o: any) => { const out: any = {}; for (const k in o.client) { const r = o.client[k].safeParse(o.runtimeEnv[k]); out[k] = r.success ? r.data : undefined } return out }\n`
const ENV = `import { z } from 'zod'\nimport { createEnv } from './t3'\nexport const env = createEnv({ client: { NEXT_PUBLIC_BASE_URL: z.string().min(1) }, runtimeEnv: { NEXT_PUBLIC_BASE_URL: 'https://example.test' } })\n`

describe('zod stays on the page: the call is left as written', () => {
  let dir
  before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'zod-stays-')) })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })
  let n = 0
  const build = async (files, options = {}, platform = 'browser') => {
    const esbuild = await import('esbuild')
    const root = path.join(dir, 'b' + n++)
    for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text) }
    const log = []
    const logger = { info: (m) => log.push(m), warn: (m) => log.push(m) }
    const entry = Object.keys(files)[0]
    const r = await esbuild.build({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'esm', platform, minify: true, write: false, metafile: true, outdir: path.join(root, 'dist'), logLevel: 'silent', external: ['react'], plugins: [esbuildPlugin({ verify: false, logger, ...options })] })
    const inputs = Object.values(r.metafile.outputs)[0].inputs
    let zod = 0
    for (const [p, v] of Object.entries(inputs)) if (/node_modules\/zod\//.test(p)) zod += v.bytesInOutput
    const compiled = Object.entries(inputs).some(([p, v]) => /node_modules\/ata-validator\//.test(p) && v.bytesInOutput > 0)
    return { zod, compiled, log, bytes: r.outputFiles[0].contents.length }
  }
  const left = (log, file, through) => log.some((l) => l.includes('left as written: ' + file + ':') && l.endsWith('compiled form would add bytes: zod stays through ' + through))

  it('a form alone is compiled and zod leaves the bundle', async () => {
    const r = await build({ 'page.tsx': FORM() })
    assert.equal(r.zod, 0)
    assert.ok(r.compiled)
    assert.ok(r.log.some((l) => /zodResolver: 1 of 1 call compiled at build time, zod is out of those files/.test(l)), r.log.join('\n'))
  })

  it('an env module beside the form: left as written, the report names the module, and the bundle is the one without the plugin', async () => {
    const files = { 'page.tsx': FORM(`import { env } from './env'\nexport const base = env.NEXT_PUBLIC_BASE_URL\n`), 'env.ts': ENV, 't3.ts': T3 }
    const r = await build(files)
    assert.ok(r.zod > 0)
    assert.equal(r.compiled, false)
    assert.ok(left(r.log, 'page.tsx', 'env.ts'), r.log.join('\n'))
    assert.ok(r.log.some((l) => /zodResolver: 0 of 1 call compiled at build time, 1 left as written with zod/.test(l)), r.log.join('\n'))
    const plain = await build(files, { compileAway: false })
    assert.equal(r.bytes, plain.bytes)
    // What the rule is for: the compiled form on this page is the bigger one.
    const forced = await build(files, { zodAlways: true })
    assert.ok(forced.zod > 0 && forced.compiled)
    assert.ok(forced.bytes > r.bytes, `${forced.bytes} against ${r.bytes}`)
    assert.ok(forced.log.some((l) => /zodResolver: 1 of 1 call compiled/.test(l)), forced.log.join('\n'))
  })

  it('a registry that reaches a form the build keeps: the form under it is named', async () => {
    const kept = `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nconst schema = z.object({ file: z.string().refine((v) => v.endsWith(suffix())) })\nconst suffix = () => '.csv'\nexport const addImport = zodResolver(schema)\n`
    const r = await build({
      'modals/edit.tsx': FORM(`import { modals } from './index'\nexport const open = (name: string) => modals[name]\n`),
      'modals/index.tsx': `import { addImport } from './add-import'\nexport const modals: Record<string, unknown> = { addImport }\n`,
      'modals/add-import.tsx': kept,
    })
    assert.ok(r.zod > 0)
    assert.ok(left(r.log, 'modals/edit.tsx', 'modals/add-import.tsx'), r.log.join('\n'))
    assert.ok(r.log.some((l) => /zodResolver: 0 of 2 calls compiled at build time, 2 left as written with zod/.test(l)), r.log.join('\n'))
  })

  it('a module of schemas and constants: named where a constant of it is read, not where only a type is', async () => {
    const shared = `import { z } from 'zod'\nexport const MAX_NAME = 40\nexport const profile = z.object({ name: z.string().max(40), email: z.email() })\nexport const other = z.object({ id: z.string() })\nexport type Profile = z.infer<typeof profile>\n`
    const page = (use) => `import { zodResolver } from '@hookform/resolvers/zod'\nimport { profile, MAX_NAME, Profile } from './schemas'\nexport const resolver = zodResolver(profile)\n${use}\n`
    const value = await build({ 'page.tsx': page('export const max = MAX_NAME\nexport const empty: Profile = { name: \'\', email: \'\' }'), 'schemas.ts': shared })
    assert.ok(value.zod > 0)
    assert.ok(left(value.log, 'page.tsx', 'schemas.ts'), value.log.join('\n'))
    const type = await build({ 'page.tsx': page('export const empty: Profile = { name: \'\', email: \'\' }\nexport type Max = typeof MAX_NAME'), 'schemas.ts': shared })
    assert.equal(type.zod, 0)
    assert.ok(type.compiled)
  })

  it('a form under a form is read as the build leaves it, so neither keeps zod for the other', async () => {
    const r = await build({ 'page.tsx': FORM(`import { resolver as child } from './child'\nexport { child }\n`), 'child.tsx': FORM() })
    assert.equal(r.zod, 0)
    assert.ok(r.log.some((l) => /zodResolver: 2 of 2 calls compiled/.test(l)), r.log.join('\n'))
  })

  it('does not follow a module under \'use server\', a dynamic import or a type import', async () => {
    const r = await build({
      'page.tsx': FORM(`import { save } from './actions'\nimport type { Env } from './env'\nexport const later = () => import('./env')\nexport const go = (e: Env) => save(e)\n`),
      'actions.ts': `'use server'\nimport { z } from 'zod'\nconst body = z.object({ id: z.string() })\nexport async function save (v: unknown) { return body.parse(v) }\n`,
      'env.ts': ENV.replace('export const env', 'export type Env = { NEXT_PUBLIC_BASE_URL?: string }\nexport const env'),
      't3.ts': T3,
    })
    assert.ok(r.compiled)
    assert.ok(r.log.some((l) => /zodResolver: 1 of 1 call compiled/.test(l)), r.log.join('\n'))
  })

  it('safeParse in a file for a browser is left the same way', async () => {
    const page = `import { z } from 'zod'\nimport { env } from './env'\nconst schema = ${SCHEMA}\nexport const base = env.NEXT_PUBLIC_BASE_URL\nexport const ok = (d: unknown) => schema.safeParse(d).success\n`
    const r = await build({ 'page.ts': page, 'env.ts': ENV, 't3.ts': T3 })
    assert.ok(r.log.some((l) => /left as written: page\.ts:\d+ schema\.safeParse\(\): compiled form would add bytes: zod stays through env\.ts$/.test(l)), r.log.join('\n'))
    assert.ok(r.log.some((l) => /safeParse: 0 of 1 zod schema compiled at build time, 1 left as written with zod/.test(l)), r.log.join('\n'))
    assert.equal(r.compiled, false)
  })

  it('a build for a server is not asked: no page loads it', async () => {
    const r = await build({ 'page.tsx': FORM(`import { env } from './env'\nexport const base = env.NEXT_PUBLIC_BASE_URL\n`), 'env.ts': ENV, 't3.ts': T3 }, {}, 'node')
    assert.ok(r.compiled)
    assert.ok(r.log.some((l) => /zodResolver: 1 of 1 call compiled/.test(l)), r.log.join('\n'))
  })
})

describe('zod stays on the page: the parts', () => {
  it('a call left for this reason leaves nothing of the first pass behind', () => {
    const id = path.join(here, 'fixtures', 'page.tsx')
    const code = FORM(`import { Validator } from 'ata-validator'\nconst v = new Validator({ type: 'string' })\nexport const s = (d: unknown) => v.validate(d)\n`)
    const run = (zodStays) => { const kept = []; const verifying = new Map(); const out = compileAway(code, id, ata, { ir: true, zodResolver: true, kept, verifying, zodStays }); return { out, kept, verifying } }
    const asked = []
    const stays = run((written) => { asked.push(written); return 'env.ts' })
    const off = (() => { const kept = []; const verifying = new Map(); const out = compileAway(code, id, ata, { ir: true, zodResolver: false, kept, verifying }); return { out, kept, verifying } })()
    const free = run(() => null)
    assert.equal(free.out.zod, 1)
    assert.equal(asked.length, 1)
    assert.ok(!/from 'zod'/.test(asked[0]), 'the rule is asked with the file as the rewrite leaves it')
    assert.equal(stays.out.code, off.out.code)
    assert.equal(stays.out.zod, 0)
    assert.deepEqual(stays.kept.map((k) => k.reason), ['zodResolver(schema): compiled form would add bytes: zod stays through env.ts'])
    assert.deepEqual([...stays.verifying.keys()], [...off.verifying.keys()])
    assert.ok(free.verifying.size > stays.verifying.size)
  })

  it('runtimeImports: what TypeScript erases is not an import', () => {
    const r = runtimeImports(`import type { A } from './a'\nimport { type B, b } from './b'\nimport { C } from './c'\nimport { d } from './d'\nimport './e'\nimport { z } from 'zod'\nimport { F } from './f'\nexport { g } from './g'\nexport * from './h'\nexport type { I } from './i'\nconst x: C = b as C\nexport const y = <F prop={x} />\nexport type Z = z.infer<typeof d>\n`, 'page.tsx')
    assert.deepEqual(r, { s: ['./e', './g', './h', './b', './f'], zod: false, server: false })
    assert.equal(runtimeImports(`import { z } from 'zod/v4'\nexport const s = z.string()\n`, 'a.ts').zod, true)
    assert.equal(runtimeImports(`import { zodResolver } from '@hookform/resolvers/zod'\nexport const r = zodResolver\n`, 'a.ts').zod, true)
    // A JavaScript file keeps what it imports: nothing erases it.
    assert.deepEqual(runtimeImports(`import { a } from './a'\n`, 'page.js').s, ['./a'])
    assert.deepEqual(runtimeImports(`'use server'\nimport { z } from 'zod'\nexport const s = z.string()\n`, 'a.ts'), { s: [], zod: false, server: true })
    assert.equal(runtimeImports('const = ', 'a.ts'), null)
  })

  it('zodThrough: the nearest module with zod, never the file itself, never through a server module', () => {
    const g = { a: { zod: false, files: ['b', 'c'] }, b: { zod: false, files: ['page', 'd'] }, c: { zod: false, server: true, files: ['e'] }, d: { zod: true, files: [] }, e: { zod: true, files: [] }, page: { zod: true, files: ['a'] } }
    assert.equal(zodThrough('page', ['a'], (f) => g[f]), 'd')
    assert.equal(zodThrough('page', ['c'], (f) => g[f]), null)
    assert.equal(zodThrough('page', ['missing'], (f) => g[f] || null), null)
    assert.equal(zodThrough('page', ['d', 'a'], (f) => g[f]), 'd')
  })
})
