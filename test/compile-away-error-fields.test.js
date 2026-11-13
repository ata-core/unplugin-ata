// `errorFields: 'auto'`: a validator whose errors the code reads only through
// keyword, instancePath, schemaPath, params and message is compiled with
// plain errors, as if it had been given `richErrors: false`. Those five
// fields hold the same values in the same order either way, so the code
// computes what it computed before, and the rich error pipeline leaves the
// bundle. Wherever an error, the list or the result can reach code the build
// does not see, the validator keeps its rich errors.

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
before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-fields-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const SCHEMA = `{ type: 'object', properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 13 }, plan: { enum: ['free', 'pro'] }, tags: { type: 'array', items: { type: 'string', minLength: 2 }, uniqueItems: true }, nick: { type: 'string', default: 'anon' } }, required: ['email', 'name'], additionalProperties: false }`
const DOCS = [{ email: 'a@b.co', name: 'n' }, { email: 'x', age: 3, plan: 'fre', nme: 'a', tags: ['a', 'a'] }, {}, { email: 'a@b.co', name: 'n', age: 12 }, 'nope', null, [], { email: 1, name: 2, tags: 'x' }]

const head = `import { Validator } from 'ata-validator'\nconst v = new Validator(${SCHEMA})\nconst sink = []\nconst give = (x) => { sink.push(x); return x }\n`
// Each body exports run(d), which returns only JSON values.
const PLAIN = {
  'map over message and instancePath': `export const run = (d) => { const r = v.validate(d); return r.valid ? r.data : r.errors.map((e) => e.instancePath + ' ' + e.message) }`,
  'the call read directly': `export const run = (d) => v.validate(d).valid`,
  'errors read off the call': `export const run = (d) => v.validate(d).errors.map((e) => e.keyword)`,
  'destructured result': `export const run = (d) => { const { valid, errors, data } = v.validate(d); return valid ? data : errors.length }`,
  'destructured error in the callback': `export const run = (d) => v.validate(d).errors.map(({ instancePath, message, params }) => [instancePath, message, params])`,
  'for of': `export const run = (d) => { const out = {}; const r = v.validate(d); for (const e of r.errors) out[e.instancePath] = e.message; return out }`,
  'for of, destructured': `export const run = (d) => { const out = []; for (const { keyword, schemaPath } of v.validate(d).errors) out.push(keyword, schemaPath); return out }`,
  'first error by index': `export const run = (d) => { const r = v.validate(d); const first = r.errors[0]; return first ? first.message : null }`,
  'optional chain on an index': `export const run = (d) => v.validate(d).errors[0]?.message ?? null`,
  'find then read': `export const run = (d) => { const r = v.validate(d); return r.errors.find((e) => e.instancePath === '/email')?.message ?? null }`,
  'filter then map': `export const run = (d) => v.validate(d).errors.filter((e) => e.keyword !== 'required').map((e) => e.message)`,
  'some, every, forEach, at, length': `export const run = (d) => { const r = v.validate(d); let k = 0; r.errors.forEach((e, i) => { k += i + e.message.length }); return [r.errors.some((e) => e.keyword === 'format'), r.errors.every((e) => e.schemaPath.startsWith('#')), r.errors.at(-1)?.keyword ?? null, r.errors.length, k] }`,
  'params handed on': `export const run = (d) => v.validate(d).errors.map((e) => give(e.params))`,
  'the same names in two functions': `export const run = (d) => { const r = v.validate(d); return r.errors.map((e) => e.message) }\nexport const other = (d) => { const r = v.validate(d); return r.errors.map((e) => e.keyword) }`,
  'isValidObject beside validate': `export const run = (d) => v.isValidObject(d) ? true : v.validate(d).errors.map((e) => e.message)`,
  'the result unread': `export const run = (d) => { v.validate(d); return d }`,
}
const RICH = {
  'the result returned': `export const run = (d) => JSON.parse(JSON.stringify(v.validate(d)))`,
  'the result handed over': `export const run = (d) => { const r = v.validate(d); give(r); return r.valid }`,
  'the list returned': `export const run = (d) => JSON.parse(JSON.stringify(v.validate(d).errors))`,
  'the list handed over': `export const run = (d) => { const r = v.validate(d); give(r.errors); return r.valid }`,
  'the list spread': `export const run = (d) => JSON.parse(JSON.stringify([...v.validate(d).errors]))`,
  'the list in an object': `export const run = (d) => { const { errors } = v.validate(d); return JSON.parse(JSON.stringify({ errors })) }`,
  'an error returned from the callback': `export const run = (d) => JSON.parse(JSON.stringify(v.validate(d).errors.map((e) => e)))`,
  'an error handed over': `export const run = (d) => v.validate(d).errors.map((e) => { give(e); return e.message })`,
  'a rich field read': `export const run = (d) => v.validate(d).errors.map((e) => e.code)`,
  'another rich field read': `export const run = (d) => v.validate(d).errors.map((e) => e.suggestion ? e.suggestion.text : e.message)`,
  'a computed field read': `export const run = (d) => v.validate(d).errors.map((e) => e['doc' + 'Url'])`,
  'an error in a template': `export const run = (d) => v.validate(d).errors.map((e) => typeof \`\${e}\`)`,
  'the rest of an error': `export const run = (d) => v.validate(d).errors.map(({ message, ...rest }) => Object.keys(rest).length)`,
  'a named callback': `const pick = (e) => e.code\nexport const run = (d) => v.validate(d).errors.map(pick)`,
  'the third callback argument': `export const run = (d) => v.validate(d).errors.map((e, i, all) => Object.keys(all[i]).length)`,
  'the found error returned': `export const run = (d) => JSON.parse(JSON.stringify(v.validate(d).errors.find((e) => e.keyword === 'format') ?? null))`,
  'the filtered list returned': `export const run = (d) => JSON.parse(JSON.stringify(v.validate(d).errors.filter((e) => e.keyword === 'format')))`,
  'an error by index handed over': `export const run = (d) => { const r = v.validate(d); return r.valid ? null : Object.keys(give(r.errors[0])).length }`,
  'the result reassigned': `export const run = (d) => { let r = v.validate(d); const q = r; return Object.keys(q.errors[0] || {}).length }`,
  'a method the build does not know': `export const run = (d) => v.validate(d).errors.reduce((a, e) => a + Object.keys(e).length, 0)`,
  'an unknown field of the result': `export const run = (d) => { const r = v.validate(d); return typeof r.toOutput }`,
}

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
const same = (a, b, what) => { for (const d of DOCS) { const x = structuredClone(d); const y = structuredClone(d); assert.equal(JSON.stringify(b.run(y)), JSON.stringify(a.run(x)), `${what}: run(${JSON.stringify(d)})`); assert.deepEqual(y, x, `${what}: the document after`) } }
// The rich pipeline in a rewrite: its error constructor among the kernels,
// or a wrapper that enriches.
const rich = (code) => /\bE as __ataK_E\b|tableRich|compiled-bare-rich|ata-validator\/compiled'|error-runtime/.test(code)

describe('errorFields: plain errors where only plain fields are read', { skip: !(ata.ir && ata.compiledPlain) && 'the installed ata-validator has no plain modules' }, () => {
  for (const [name, body] of Object.entries(PLAIN)) {
    for (const options of [{}, { table: true }, { ir: false }]) {
      it(`plain: ${name} ${JSON.stringify(options)}`, async () => {
        const { out, original, rewritten } = await both(body, options)
        assert.equal(rich(out.code), false, 'no rich error pipeline in the rewrite')
        same(original, rewritten, name)
        if (original.other) same({ run: original.other }, { run: rewritten.other }, name)
      })
    }
  }
  for (const [name, body] of Object.entries(RICH)) {
    it(`rich: ${name}`, async () => {
      const { out, original, rewritten } = await both(body, {})
      assert.equal(rich(out.code), true, 'the rich errors stay')
      same(original, rewritten, name)
    })
  }
  it('errorFields: \'all\' keeps rich errors everywhere', async () => {
    const { out, original, rewritten } = await both(PLAIN['map over message and instancePath'], { errorFields: 'all' })
    assert.equal(rich(out.code), true)
    same(original, rewritten, 'all')
  })
  it('a validator given richErrors: true keeps them', async () => {
    const code = head.replace(`${SCHEMA})`, `${SCHEMA}, { richErrors: true })`) + PLAIN['map over message and instancePath'] + '\n'
    const out = compileAway(code, path.join(dir, 'explicit.mjs'), ata, { ir: true })
    assert.ok(out === null || rich(out.code))
  })
  it('counts the validator as plain in the report', async () => {
    const { out } = await both(PLAIN['for of'], {})
    assert.equal(out.kinds.plain, 1)
    assert.equal(out.kinds.errors, 0)
  })
})
