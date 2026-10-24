// A validator handed over as a value (`body: check` in a route's options, an
// argument of a call) is compiled away where the wrapper carries Standard
// Schema, and answers a consumer that reads `~standard` as the runtime does.
// A use that reads a property, assigns, exports or returns it keeps the
// runtime.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let dir
let n = 0
// Loaded before the tests are declared: whether the positive cases run
// depends on the installed ata-validator.
const ata = await __internal.loadAta()
before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-handed-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const SCHEMA = "{ type: 'object', required: ['email', 'age'], properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 13 } }, additionalProperties: false }"
const DOCS = [{ email: 'a@b.co', age: 20 }, { email: 'x', age: 3, extra: 1 }, {}, 'nope']
// A stand-in for a router: it keeps what it is given and validates through ~standard, as Elysia and Hono do.
const CONSUMER = `const routes = []
const post = (url, handler, hooks) => { routes.push({ url, handler, hooks }); return { post } }
export const run = (d) => { const s = routes[0].hooks.body['~standard']; const r = s.validate(structuredClone(d)); return r.issues ? { issues: r.issues.map((i) => [i.message, i.path]) } : { value: r.value } }
`
async function build (code) {
  const file = path.join(dir, `entry-${n++}.mjs`)
  await fs.writeFile(file, code)
  const out = compileAway(code, file, ata, {})
  const original = await import(pathToFileURL(file).href)
  let rewritten = original
  if (out) { const f = path.join(dir, `out-${n++}.mjs`); await fs.writeFile(f, out.code); rewritten = await import(pathToFileURL(f).href) }
  return { replaced: !!out && !out.code.includes('new Validator('), original, rewritten, code: out ? out.code : null }
}

describe('a validator handed over as a value', () => {
  const skip = ata.compiledStandard !== true ? 'needs an ata-validator whose compiled wrapper carries Standard Schema (1.60.0)' : false

  it('in a route option, compiled, with the same Standard Schema answers', { skip }, async () => {
    const r = await build(`import { Validator } from 'ata-validator'\n${CONSUMER}const signup = new Validator(${SCHEMA})\npost('/signup', (c) => c, { body: signup })\n`)
    assert.equal(r.replaced, true)
    assert.ok(!r.code.includes("from 'ata-validator'"), 'the runtime import is gone')
    for (const d of DOCS) assert.deepEqual(r.rewritten.run(d), r.original.run(d), JSON.stringify(d))
  })

  it('as a direct call argument, with a method call elsewhere in the file', { skip }, async () => {
    const r = await build(`import { Validator } from 'ata-validator'\n${CONSUMER}const v = new Validator(${SCHEMA})\nexport const ok = v.isValidObject({ email: 'a@b.co', age: 20 })\nconst register = (check) => post('/x', (c) => c, { body: check })\nregister(v)\n`)
    assert.equal(r.replaced, true)
    for (const d of DOCS) assert.deepEqual(r.rewritten.run(d), r.original.run(d), JSON.stringify(d))
    assert.equal(r.rewritten.ok, true)
  })

  it('keeps the runtime for an element read off an array that holds it', async () => {
    const r = await build(`import { Validator } from 'ata-validator'\n${CONSUMER}const v = new Validator(${SCHEMA})\npost('/x', (c) => c, { body: [v][0] })\n`)
    assert.equal(r.replaced, false)
  })

  for (const [name, use] of [
    ['a property read', 'export const s = v.schema'],
    ['an assignment', 'let other = null\nexport const set = () => { other = v }'],
    ['a return', 'export const get = () => v'],
    ['an export', 'export { v }'],
    ['a member call that is not a validator method', 'export const x = v.toString()'],
  ]) {
    it(`keeps the runtime for ${name}`, async () => {
      const r = await build(`import { Validator } from 'ata-validator'\n${CONSUMER}const v = new Validator(${SCHEMA})\npost('/x', (c) => c, { body: v })\n${use}\n`)
      assert.equal(r.replaced, false, name)
    })
  }
})
