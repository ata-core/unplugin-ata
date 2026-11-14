// `smallFormats`: a written module names ata-validator's smaller check of a
// format where the build knows the code goes to a browser, and the scanner
// elsewhere. With an ata-validator that has no such option the module is
// what it was.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { unpluginFactory } from '../src/index.js'
import esbuildPlugin from '../src/esbuild.js'
import { __internal } from '../src/core.js'

const require = createRequire(import.meta.url)
const loader = require('../src/turbopack.cjs')
const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
const has = (() => { try { return ata.ir.specialize({ type: 'string', format: 'email' }, { smallFormats: true }).includes('fmt_email_s') } catch { return false } })()

const FORM = "import { Validator } from 'ata-validator'\nconst v = new Validator({ type: 'object', properties: { email: { type: 'string', format: 'email' }, site: { type: 'string', format: 'uri' } }, required: ['email'] })\nexport const check = (d) => v.validate(d)\n"
// One project directory with the form in it, made for the run.
const dir = await fs.mkdtemp(path.join(here, 'fixtures', 'small-formats-'))
const file = path.join(dir, 'form.js')
await fs.writeFile(file, FORM)
after(() => fs.rm(dir, { recursive: true, force: true }))
const hooks = async (options, setup) => { const h = unpluginFactory({ root: dir, verify: false, report: false, table: false, ...options }); if (setup) setup(h); await h.buildStart.call({}); return h }
const viaLoader = (target, options = {}) => new Promise((resolve, reject) => {
  loader.call({ async: () => (err, code) => (err ? reject(err) : resolve(code)), getOptions: () => ({ verify: false, report: false, table: false, ...options }), resourcePath: file, rootContext: dir, target }, FORM)
})
const small = (code) => /fmt_email_s/.test(code) && /fmt_uri_s/.test(code)
const scanners = (code) => /fmt_email\b(?!_s)/.test(code) && !/fmt_\w+_s\b/.test(code)

describe('smallFormats', { skip: !has && 'the installed ata-validator has no smallFormats' }, () => {
  it('true names the smaller checks, false the scanners', async () => {
    assert.ok(small((await (await hooks({ smallFormats: true })).transform.call({}, FORM, file)).code))
    assert.ok(scanners((await (await hooks({ smallFormats: false })).transform.call({}, FORM, file)).code))
  })
  it("'auto' keeps the scanners where the target is not known", async () => {
    assert.ok(scanners((await (await hooks({})).transform.call({}, FORM, file)).code))
  })
  it("'auto' follows the Turbopack loader's target", async () => {
    assert.ok(small(await viaLoader('web')))
    assert.ok(scanners(await viaLoader('node')))
    assert.ok(scanners(await viaLoader('web', { smallFormats: false })))
  })
  it("'auto' follows a webpack compiler's target", async () => {
    const compiler = (web) => ({ context: dir, options: { externalsPresets: { web } } })
    assert.ok(small((await (await hooks({}, (h) => h.webpack(compiler(true)))).transform.call({}, FORM, file)).code))
    assert.ok(scanners((await (await hooks({}, (h) => h.webpack(compiler(false)))).transform.call({}, FORM, file)).code))
  })
  it("'auto' follows Vite's ssr flag", async () => {
    const config = (ssr) => ({ root: dir, build: { ssr }, logger: null, resolve: {} })
    const client = await hooks({}, (h) => h.vite.configResolved(config(false)))
    assert.ok(small((await client.transform.call({}, FORM, file)).code))
    assert.ok(scanners((await client.transform.call({}, FORM, file, { ssr: true })).code))
    assert.ok(scanners((await (await hooks({}, (h) => h.vite.configResolved(config(true)))).transform.call({}, FORM, file)).code))
  })
  it("'auto' follows esbuild's platform", async () => {
    const { build } = await import('esbuild')
    const run = async (platform) => (await build({ absWorkingDir: dir, entryPoints: ['form.js'], bundle: true, format: 'esm', platform, write: false, logLevel: 'silent', external: ['ata-validator', 'ata-validator/*'], plugins: [esbuildPlugin({ verify: false, report: false, table: false })] })).outputFiles[0].text
    assert.ok(small(await run('browser')))
    assert.ok(scanners(await run('node')))
  })
})

describe('smallFormats on an ata-validator without it', { skip: has && 'the installed ata-validator has smallFormats' }, () => {
  it('writes the module it wrote before', async () => {
    const on = (await (await hooks({ smallFormats: true })).transform.call({}, FORM, file)).code
    const off = (await (await hooks({ smallFormats: false })).transform.call({}, FORM, file)).code
    assert.equal(on, off)
    assert.doesNotMatch(on, /new Validator\(/)
  })
})
