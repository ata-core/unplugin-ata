// A validator whose validate() results are read through `valid` and nothing
// else is written without its error functions, as one that only calls
// isValidObject() is: validate() answers `{ valid }` from the verdict
// function. The answer and what the defaults pass writes onto the document
// are those of the runtime Validator; a result read any other way keeps its
// errors.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
let dir
let n = 0
before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-valid-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const SCHEMA = `{ type: 'object', properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 13 }, plan: { enum: ['free', 'pro'], default: 'free' }, tags: { type: 'array', items: { type: 'string', minLength: 2 } } }, required: ['email'], additionalProperties: false }`
const DOCS = [{ email: 'a@b.co' }, { email: 'a@b.co', age: 20, plan: 'pro', tags: ['ab'] }, { email: 'x', age: 3 }, { email: 'a@b.co', extra: 1 }, {}, 'nope', null, [], { email: 'a@b.co', tags: ['a'] }]
const head = `import { Validator } from 'ata-validator'\nconst v = new Validator(${SCHEMA})\nconst sink = []\nconst give = (x) => { sink.push(x); return x }\n`

const VALID_ONLY = {
  'read off the call': `export const run = (d) => v.validate(d).valid`,
  'through a const': `export const run = (d) => { const r = v.validate(d); return r.valid ? 'yes' : 'no' }`,
  'destructured': `export const run = (d) => { const { valid } = v.validate(d); return valid }`,
  'in a condition, twice in the file': `export const run = (d) => { if (!v.validate(d).valid) return 0; return 1 }\nexport const other = (d) => { const r = v.validate(d); return [r.valid, !r.valid] }`,
  'beside isValidObject': `export const run = (d) => [v.isValidObject(d), v.validate(d).valid]`,
  'the result unread': `export const run = (d) => { v.validate(d); return d }`,
  'the verdict handed on': `export const run = (d) => give(v.validate(d).valid)`,
}
const ERRORS = {
  'errors read': `export const run = (d) => { const r = v.validate(d); return r.valid ? [] : r.errors.map((e) => e.message) }`,
  'the count of errors': `export const run = (d) => v.validate(d).errors.length`,
  'data read': `export const run = (d) => { const r = v.validate(d); return r.valid ? r.data : null }`,
  'the result returned': `export const run = (d) => JSON.parse(JSON.stringify(v.validate(d)))`,
  'the result handed over': `export const run = (d) => { const r = v.validate(d); give(r); return r.valid }`,
  'the result reassigned': `export const run = (d) => { let r = v.validate(d); return r.valid }`,
  'a computed read': `export const run = (d) => v.validate(d)['valid']`,
  'a pattern with a rest': `export const run = (d) => { const { valid, ...rest } = v.validate(d); return [valid, typeof rest] }`,
  'one call reads errors': `export const run = (d) => v.validate(d).valid\nexport const other = (d) => v.validate(d).errors.length`,
}
// What writes errors in a rewrite: a plain module names the keyword of each,
// a rich one takes the error constructor from the kernels, and the rest are
// the table interpreter and the wrappers that carry errors.
const hasErrors = (code) => /keyword:|\bE as __ataK_E\b|tablePlain|tableRich|error-runtime|compiled-bare-rich|ata-validator\/compiled'/.test(code)

async function both (body, options) {
  const code = head + body + '\n'
  const file = path.join(dir, `in-${n++}.mjs`)
  await fs.writeFile(file, code)
  const out = compileAway(code, file, ata, { ir: true, ...options })
  assert.ok(out && out.replaced === 1, 'the call is replaced')
  const f = path.join(dir, `out-${n++}.mjs`)
  await fs.writeFile(f, out.code)
  return { out, original: await import(pathToFileURL(file).href), rewritten: await import(pathToFileURL(f).href) }
}
// The same answer, and the same document afterwards (the default written in).
const same = (a, b, what) => { for (const d of DOCS) { const x = structuredClone(d); const y = structuredClone(d); assert.equal(JSON.stringify(b(y)), JSON.stringify(a(x)), `${what}: run(${JSON.stringify(d)})`); assert.deepEqual(y, x, `${what}: the document after`) } }

describe('a validator read through valid alone carries no error functions', { skip: !ata.ir && 'the installed ata-validator has no ir' }, () => {
  for (const [name, body] of Object.entries(VALID_ONLY)) {
    it(`valid only: ${name}`, async () => {
      const { out, original, rewritten } = await both(body, {})
      assert.equal(hasErrors(out.code), false, 'the error functions are still written')
      assert.equal(out.kinds.verdict, 1)
      same(original.run, rewritten.run, name)
      if (original.other) same(original.other, rewritten.other, name)
    })
    it(`valid only, as a table plan or without the ir: ${name}`, async () => {
      for (const options of [{ table: true }, { ir: false }]) {
        const { original, rewritten } = await both(body, options)
        same(original.run, rewritten.run, name + JSON.stringify(options))
        if (original.other) same(original.other, rewritten.other, name)
      }
    })
  }
  for (const [name, body] of Object.entries(ERRORS)) {
    it(`errors kept: ${name}`, async () => {
      const { out, original, rewritten } = await both(body, {})
      assert.equal(hasErrors(out.code), true, 'the error functions are gone')
      assert.equal(out.kinds.verdict, 0)
      same(original.run, rewritten.run, name)
      if (original.other) same(original.other, rewritten.other, name)
    })
  }
  it('writes the default onto a valid document, as validate() does', async () => {
    const { original, rewritten } = await both(VALID_ONLY['read off the call'], {})
    const a = { email: 'a@b.co' }; const b = { email: 'a@b.co' }
    assert.equal(rewritten.run(b), original.run(a))
    assert.deepEqual(b, { email: 'a@b.co', plan: 'free' })
    assert.deepEqual(a, b)
  })
  it('errorFields: \'all\' keeps the error functions', async () => {
    const { out, original, rewritten } = await both(VALID_ONLY['read off the call'], { errorFields: 'all' })
    assert.equal(hasErrors(out.code), true)
    same(original.run, rewritten.run, 'all')
  })
})
