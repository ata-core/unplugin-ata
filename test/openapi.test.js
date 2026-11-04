// The `openapi` option: one module a server imports as it is and a page's
// build compiles; the two must give the same answer on every document.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileOpenAPI } from '../src/openapi.js'
import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ata = await __internal.loadAta()
let dir
const hasOpenAPI = await import('ata-validator/openapi').then(() => true, () => false)
before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-openapi-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const DOC = {
  openapi: '3.0.3',
  paths: {
    '/users': { post: { operationId: 'createUser', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewUser' } } } } } },
    '/orders': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Line' }, minItems: 1 }, coupon: { type: 'string', pattern: '^[A-Z0-9]{6}$', nullable: true } }, required: ['items'], additionalProperties: false } } } } } },
  },
  components: { schemas: {
    NewUser: { type: 'object', properties: { email: { type: 'string', format: 'email' }, name: { type: 'string', minLength: 2, maxLength: 50 }, age: { type: 'integer', minimum: 13, exclusiveMinimum: true }, website: { type: 'string', format: 'uri', nullable: true } }, required: ['email', 'name'], additionalProperties: false },
    Line: { type: 'object', properties: { sku: { type: 'string', minLength: 1 }, qty: { type: 'integer', minimum: 1, maximum: 99 } }, required: ['sku', 'qty'] },
  } },
}
const DOCS = [{}, { email: 'ada@example.com', name: 'Ada' }, { email: 'bad', name: 'A', age: 13, website: 'https://x y', extra: 1 }, { email: 'a@b.co', name: 'Al', age: 14, website: null }, { items: [] }, { items: [{ sku: 'a', qty: 1 }], coupon: null }, { items: [{ sku: '', qty: 100 }, { qty: 1 }], coupon: 'abc' }, null, [], 'x', 42]

describe('openapi', { skip: !hasOpenAPI && 'the installed ata-validator has no ata-validator/openapi' }, () => {
  it('writes one module and its types, one validator per operation', async () => {
    const file = path.join(dir, 'api.json')
    await fs.writeFile(file, JSON.stringify(DOC))
    const written = []
    const r = await compileOpenAPI('api.json', dir, async (f, s) => { written.push(f); await fs.writeFile(f, s); return true })
    assert.deepEqual(r[0].operations, ['createUser', 'postOrders'])
    assert.deepEqual(written.map((f) => path.basename(f)), ['api.validators.mjs', 'api.validators.d.mts'])
    const dts = await fs.readFile(path.join(dir, 'api.validators.d.mts'), 'utf8')
    assert.match(dts, /export declare namespace CreateUser \{/)
    assert.match(dts, /export declare const createUserBody: \{ validate\(data: unknown\): Result<CreateUserBody>/)
    assert.match(dts, /export declare const postOrdersBody/)
  })
  it('the server reads the module as it is, the page compiles it, and they agree', async () => {
    const src = await fs.readFile(path.join(dir, 'api.validators.mjs'), 'utf8')
    const server = await import(pathToFileURL(path.join(dir, 'api.validators.mjs')).href)
    for (const table of [false, true]) {
      const out = compileAway(src, path.join(dir, 'api.validators.mjs'), ata, { ir: true, table })
      assert.ok(out && !out.code.includes('new Validator('), 'every validator is compiled for the page')
      const f = path.join(dir, `page-${table}.mjs`); await fs.writeFile(f, out.code)
      const page = await import(pathToFileURL(f).href)
      for (const name of ['createUserBody', 'postOrdersBody']) for (const d of DOCS) {
        const a = server[name].validate(structuredClone(d)); const b = page[name].validate(structuredClone(d))
        assert.equal(JSON.stringify([b.valid, b.errors]), JSON.stringify([a.valid, a.errors]), `${name}, table ${table}: ${JSON.stringify(d)}`)
        assert.equal(page[name].isValidObject(structuredClone(d)), server[name].isValidObject(structuredClone(d)))
      }
    }
  })
})
