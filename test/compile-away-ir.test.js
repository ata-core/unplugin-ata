// The `ir` option: a validator only called (validate(), isValidObject()) is
// compiled by ata-validator/ir into a module that imports its helpers from
// ata-validator/kernels. The rewritten file must answer every document as the
// runtime does: the verdict, every error with every field in order, rich and
// plain, and the document after defaults are filled. A schema or an option
// the IR does not cover keeps the existing path.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compileAway } from '../src/compile-away.js'
import unplugin from '../src/index.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let dir
let n = 0
const ata = await __internal.loadAta()
before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-ir-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const SCHEMAS = {
  signup: "{ type: 'object', required: ['email', 'age'], properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 13, maximum: 130 }, name: { type: 'string', minLength: 1, maxLength: 40, default: 'anon' }, plan: { enum: ['free', 'pro'], default: 'free' }, tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, uniqueItems: true, maxItems: 3 } }, additionalProperties: false }",
  address: "{ $defs: { line: { type: 'string', minLength: 2 } }, type: 'object', required: ['street', 'zip'], properties: { street: { $ref: '#/$defs/line' }, city: { $ref: '#/$defs/line' }, zip: { type: 'string', pattern: '^[0-9]{5}$' }, country: { const: 'TR' } } }",
  payment: "{ type: 'object', required: ['method'], properties: { method: { enum: ['card', 'iban'] } }, oneOf: [{ properties: { method: { const: 'card' }, card: { type: 'string', minLength: 12 } }, required: ['card'] }, { properties: { method: { const: 'iban' }, iban: { type: 'string', pattern: '^TR' } }, required: ['iban'] }] }",
  tree: "{ $id: 'https://example.com/tree', type: 'object', properties: { value: { type: 'number' }, children: { type: 'array', items: { $ref: '#' } } }, required: ['value'], unevaluatedProperties: false }",
}
const DOCS = [
  { email: 'a@b.co', age: 20 }, { email: 'x', age: 3, extra: 1 }, { email: 'a@b.co', age: 20, tags: ['a', 'a', 'B', 'c'] }, {}, 'nope', null, 7, [],
  { street: 'x', zip: '123' }, { street: 'Main', city: 'Ankara', zip: '06100', country: 'TR' }, { street: 1, zip: '06100', country: 'DE' },
  { method: 'card', card: '4111111111111111' }, { method: 'card' }, { method: 'iban', iban: 'DE00' }, { method: 'cash' },
  { value: 1, children: [{ value: 2, children: [] }, { value: 'x' }, { children: [] }] }, { value: 1, stray: true },
]

async function load (code, options) {
  const file = path.join(dir, `entry-${n++}.mjs`)
  await fs.writeFile(file, code)
  const kept = []
  const out = compileAway(code, file, ata, { ...options, kept })
  const original = await import(pathToFileURL(file).href)
  let rewritten = original
  if (out) { const f = path.join(dir, `out-${n++}.mjs`); await fs.writeFile(f, out.code); rewritten = await import(pathToFileURL(f).href) }
  return { out, kept, original, rewritten }
}
const shape = (r) => JSON.stringify([r.valid, 'data' in r && r.valid ? '<data>' : null, (r.errors || []).map((e) => Object.keys(e).map((k) => [k, e[k] === undefined ? '<undef>' : e[k]]))])

describe('compile-away, ir option', { skip: !ata.ir && 'the installed ata-validator has no ata-validator/ir' }, () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    for (const opts of ['', ', { richErrors: false }', ', { useDefaults: false }']) {
      it(`${name}${opts}: the IR module answers as the runtime`, async () => {
        const code = `import { Validator } from 'ata-validator'\nconst v = new Validator(${schema}${opts})\nexport const run = (d) => { const r = v.validate(d); return [r, d] }\nexport const ok = (d) => v.isValidObject(d)\n`
        const { out, rewritten, original } = await load(code, { ir: true })
        assert.ok(out && !out.code.includes('new Validator('), 'the call is replaced')
        assert.match(out.code, /from 'ata-validator\/kernels'/)
        assert.doesNotMatch(out.code, /compiled-bare-rich|ata-validator\/compiled'/, 'no runtime wrapper')
        for (const doc of DOCS) {
          const [ra, da] = original.run(structuredClone(doc))
          const [rb, db] = rewritten.run(structuredClone(doc))
          assert.equal(shape(rb), shape(ra), `validate(${JSON.stringify(doc)})`)
          if (ra.valid) assert.equal(rb.data, db, 'data is the checked value')
          assert.deepEqual(db, da, `the document after defaults, ${JSON.stringify(doc)}`)
          assert.equal(rewritten.ok(structuredClone(doc)), original.ok(structuredClone(doc)), `isValidObject(${JSON.stringify(doc)})`)
        }
      })
    }
  }

  it('a validator that only answers isValidObject gets the verdict module', async () => {
    const code = `import { Validator } from 'ata-validator'\nconst v = new Validator(${SCHEMAS.signup})\nexport const ok = (d) => v.isValidObject(d)\n`
    const { out, rewritten, original } = await load(code, { ir: true })
    assert.match(out.code, /return \{ isValidObject: isValid \}/)
    assert.doesNotMatch(out.code, /\bE as __ataK_E\b/, 'no error constructor in a verdict module')
    for (const doc of DOCS) assert.equal(rewritten.ok(structuredClone(doc)), original.ok(structuredClone(doc)))
  })

  it('two schemas in a file share one kernels import', async () => {
    const code = `import { Validator } from 'ata-validator'\nconst a = new Validator(${SCHEMAS.signup})\nconst b = new Validator(${SCHEMAS.address})\nexport const run = (d) => [a.validate(d).valid, b.validate(d).valid]\n`
    const { out } = await load(code, { ir: true })
    assert.equal(out.code.match(/from 'ata-validator\/kernels'/g).length, 1)
  })

  it('compileAway without the ir flag takes the existing path', async () => {
    const code = `import { Validator } from 'ata-validator'\nconst v = new Validator(${SCHEMAS.signup})\nexport const run = (d) => v.validate(d)\n`
    const { out } = await load(code, {})
    assert.doesNotMatch(out.code, /ata-validator\/kernels/)
  })

  it('the plugin uses the IR by default, and ir: false turns it off', async () => {
    const esbuild = await import('esbuild')
    const code = `import { Validator } from 'ata-validator'\nconst v = new Validator(${SCHEMAS.signup})\nexport const run = (d) => v.validate(d)\n`
    const file = path.join(dir, `default-${n++}.mjs`); await fs.writeFile(file, code)
    const build = async (opts) => (await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', write: false, external: ['ata-validator', 'ata-validator/*'], plugins: [unplugin.esbuild({ schemas: 'none/*.json', types: false, ...opts })], logLevel: 'silent' })).outputFiles[0].text
    assert.match(await build({}), /from "ata-validator\/kernels"/)
    assert.doesNotMatch(await build({ ir: false }), /ata-validator\/kernels/)
  })

  it('an option the IR does not reproduce keeps the existing path', async () => {
    const code = `import { Validator } from 'ata-validator'\nconst v = new Validator(${SCHEMAS.signup}, { removeAdditional: true })\nexport const run = (d) => v.validate(d)\n`
    const { out } = await load(code, { ir: true })
    assert.ok(!out || !/ata-validator\/kernels/.test(out.code))
  })

  it('a schema the IR refuses keeps the existing path', async () => {
    // A custom error message: a module cannot carry it, so the module writer
    // declines ("ir: ..."), and the existing path compiles or keeps the runtime.
    const schema = "{ type: 'object', properties: { name: { type: 'string', minLength: 2, errorMessage: 'two letters at least' } } }"
    const code = `import { Validator } from 'ata-validator'\nconst v = new Validator(${schema})\nexport const run = (d) => v.validate(d)\n`
    let threw = null
    try { ata.ir.specialize({ type: 'object', properties: { name: { type: 'string', minLength: 2, errorMessage: 'two letters at least' } } }) } catch (e) { threw = e.message }
    assert.match(String(threw), /^ir: /, 'the IR declines this schema')
    const { out, rewritten, original } = await load(code, { ir: true })
    assert.ok(!out || !/ata-validator\/kernels/.test(out.code))
    for (const d of [{ name: 'a' }, { name: 'ab' }, { name: 1 }]) assert.equal(JSON.stringify(rewritten.run(d)), JSON.stringify(original.run(d)))
  })

  it('a validator handed over as a value keeps the existing path', async () => {
    const code = `import { Validator } from 'ata-validator'\nconst v = new Validator(${SCHEMAS.signup})\nconst use = (x) => x\nuse(v)\nexport const run = (d) => v.validate(d)\n`
    const { out } = await load(code, { ir: true })
    assert.ok(!out || !/ata-validator\/kernels/.test(out.code))
  })
})
