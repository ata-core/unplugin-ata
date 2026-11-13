// The `table` and `sharedErrors` choices are made for what a page loads
// together, not for the project directory: a page with one form keeps its
// written module however many forms the other pages have, and an application
// that loads its forms together still takes plans.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { importsOf, resolverFor, firstLoads, perLoad, htmlScripts } from '../src/first-load.js'
import esbuildPlugin from '../src/esbuild.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
const gz = (text) => zlib.gzipSync(text, { level: 9 }).length

describe('first loads: the import graph', () => {
  it('reads static, re-exported, required and dynamic specifiers, and skips type imports', () => {
    const r = importsOf(`import a from './a'\nimport {\n  b,\n  c } from "./b.js"\nimport './side'\nimport type { T } from './types'\nexport * from './re'\nexport const s = 'not/an/import'\nconst q = require('./cjs')\nconst p = () => import('./lazy')\n`)
    assert.deepEqual(r.s, ['./a', './b.js', './side', './re', './cjs'])
    assert.deepEqual(r.d, ['./lazy'])
  })
  it('resolves extensions, index files, a .js written for a .ts, and aliases', () => {
    const all = new Set(['/p/src/a.ts', '/p/src/lib/index.tsx', '/p/src/b.ts', '/p/src/forms/x.ts'])
    const resolve = resolverFor(all, '/p', [['@/', '/p/src/']])
    assert.equal(resolve('./a', '/p/src/main.ts'), '/p/src/a.ts')
    assert.equal(resolve('./lib', '/p/src/main.ts'), '/p/src/lib/index.tsx')
    assert.equal(resolve('./b.js', '/p/src/main.ts'), '/p/src/b.ts')
    assert.equal(resolve('@/forms/x', '/p/src/pages/y.ts'), '/p/src/forms/x.ts')
    assert.equal(resolve('./a?raw', '/p/src/main.ts'), '/p/src/a.ts')
    assert.equal(resolve('react', '/p/src/main.ts'), null)
  })
  it('groups files by the root that loads them; a dynamic import starts a load of its own', () => {
    const files = new Map([
      ['/p/main.js', { s: ['./a', './b'], d: ['./lazy'] }],
      ['/p/a.js', { s: ['./shared'], d: [] }],
      ['/p/b.js', { s: [], d: [] }],
      ['/p/shared.js', { s: [], d: [] }],
      ['/p/lazy.js', { s: ['./shared'], d: [] }],
      ['/p/other.js', { s: ['./b'], d: [] }],
    ])
    const loads = firstLoads(files, resolverFor(new Set(files.keys()), '/p', []))
    assert.deepEqual([...loads.keys()].sort(), ['/p/lazy.js', '/p/main.js', '/p/other.js'])
    assert.deepEqual([...loads.get('/p/main.js')].sort(), ['/p/a.js', '/p/b.js', '/p/main.js', '/p/shared.js'])
    assert.deepEqual([...loads.get('/p/lazy.js')].sort(), ['/p/lazy.js', '/p/shared.js'])
  })
  it('gives files that only import each other a load too', () => {
    const files = new Map([['/p/x.js', { s: ['./y'], d: [] }], ['/p/y.js', { s: ['./x'], d: [] }]])
    const loads = firstLoads(files, resolverFor(new Set(files.keys()), '/p', []))
    assert.equal(loads.size, 1)
    assert.equal([...loads.values()][0].size, 2)
  })
  it('with the entries known, leaves out what no entry reaches and starts a load at each lazy import', () => {
    const files = new Map([
      ['/p/main.js', { s: ['./a'], d: ['./lazy'] }],
      ['/p/a.js', { s: [], d: [] }],
      ['/p/lazy.js', { s: ['./a'], d: [] }],
      ['/p/a.stories.js', { s: ['./a'], d: [] }],
    ])
    const loads = firstLoads(files, resolverFor(new Set(files.keys()), '/p', []), ['/p/main.js'])
    assert.deepEqual([...loads.keys()].sort(), ['/p/lazy.js', '/p/main.js'])
    // An entry that is not a file of the project: the imports alone decide.
    assert.equal(firstLoads(files, resolverFor(new Set(files.keys()), '/p', []), ['/p/virtual-entry']).has('/p/a.stories.js'), true)
  })
  it('reads the module scripts of an HTML entry', () => {
    assert.deepEqual(htmlScripts('<html><script src="/legacy.js"></script><script type="module" src="/src/main.tsx"></script></html>'), ['/src/main.tsx'])
  })
  it('keeps a file only where every load that holds it pays, and asks again after a file leaves', async () => {
    // One load of three files pays at three; `c` is also alone in a load
    // that does not pay, so it leaves, and the first load no longer pays.
    const loads = new Map([['r1', new Set(['a', 'b', 'c'])], ['r2', new Set(['c'])], ['r3', new Set(['d', 'e', 'f'])]])
    const kept = await perLoad(loads, new Set(['a', 'b', 'c', 'd', 'e', 'f']), async (files) => files.length >= 3)
    assert.deepEqual([...kept].sort(), ['d', 'e', 'f'])
  })
})

const form = (i, rich) => `new Validator({ type: 'object', properties: { a${i}: { type: 'string', minLength: 2, maxLength: 80 }, b${i}: { type: 'integer', minimum: 1, maximum: 20 }, c${i}: { type: 'string', pattern: '^[A-Z0-9]{6}$' }, d${i}: { type: 'boolean' }, e${i}: { type: 'string', maxLength: 280 }, f${i}: { enum: ['x', 'y'] } }, required: ['a${i}', 'b${i}'], additionalProperties: false }${rich ? '' : ', { richErrors: false }'})`

describe('first loads: what a build takes', { skip: !(ata.ir && ata.ir.tableModule) && 'the installed ata-validator has no table backend' }, () => {
  let dir
  before(async () => {
    dir = await fs.mkdtemp(path.join(here, 'fixtures', 'first-load-'))
    await fs.mkdir(path.join(dir, 'pages'))
    await fs.mkdir(path.join(dir, 'spa', 'forms'), { recursive: true })
    // Four pages, one form each; the first only asks for a verdict.
    await fs.writeFile(path.join(dir, 'pages', 'p0.js'), `import { Validator } from 'ata-validator'\nconst v = ${form(0, true)}\nexport const ok = (d) => v.isValidObject(d)\n`)
    for (let i = 1; i < 4; i++) await fs.writeFile(path.join(dir, 'pages', `p${i}.js`), `import { Validator } from 'ata-validator'\nconst v = ${form(i, i % 2 === 0)}\nexport const run = (d) => v.validate(d)\n`)
    // One application whose entry loads four forms, each in its own file.
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(dir, 'spa', 'forms', `f${i}.js`), `import { Validator } from 'ata-validator'\nconst v = ${form(10 + i, false)}\nexport const run${i} = (d) => v.validate(d)\n`)
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(dir, 'spa', 'forms', `f${i}.stories.js`), `import { run${i} } from './f${i}.js'\nexport default { run: run${i} }\n`)
    await fs.writeFile(path.join(dir, 'spa', 'main.js'), `${[0, 1, 2, 3].map((i) => `export { run${i} } from './forms/f${i}.js'`).join('\n')}\n`)
  })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

  const bundle = async (entries, options) => {
    const { build } = await import('esbuild')
    const r = await build({ absWorkingDir: dir, entryPoints: entries, bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, outdir: 'out', logLevel: 'silent', plugins: [esbuildPlugin({ verify: false, report: false, ...options })] })
    return Object.fromEntries(r.outputFiles.map((f) => [path.basename(f.path), f.text]))
  }

  it('a page with one form is built as with table: false, whatever the other pages hold', async () => {
    const pages = [0, 1, 2, 3].map((i) => `pages/p${i}.js`)
    const auto = await bundle(pages, {})
    const modules = await bundle(pages, { table: false })
    const plans = await bundle(pages, { table: true })
    for (const name of Object.keys(auto)) {
      assert.equal(auto[name], modules[name], `${name} keeps its written module`)
      assert.ok(gz(auto[name]) < gz(plans[name]), `${name}: ${gz(auto[name])} bytes gzipped against ${gz(plans[name])} as a plan`)
    }
  })
  it('an entry that loads four forms from four files takes plans, as before, with a story beside each form', async () => {
    const auto = await bundle(['spa/main.js'], {})
    const modules = await bundle(['spa/main.js'], { table: false })
    const plans = await bundle(['spa/main.js'], { table: true })
    assert.equal(auto['main.js'], plans['main.js'])
    assert.ok(gz(plans['main.js']) < gz(modules['main.js']), `${gz(plans['main.js'])} bytes gzipped as plans against ${gz(modules['main.js'])}`)
  })
})
