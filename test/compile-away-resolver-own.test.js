// The installed @hookform/resolvers has no compiled resolver, so the build
// writes its own into the file (OWN_RESOLVER in src/compile-away.js). It has
// to answer as the package's ataResolver does: the real one, from
// node_modules, on the same documents, under both criteria modes and with
// `raw`, compared as JSON.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import esbuildPlugin from '../src/esbuild.js'
import { ataResolver } from '@hookform/resolvers/ata-validator'

const here = path.dirname(fileURLToPath(import.meta.url))

const SCHEMA = `{
  type: 'object',
  properties: {
    username: { type: 'string', minLength: 2, maxLength: 30, pattern: '^[a-z]+$' },
    email: { type: 'string', format: 'email' },
    bio: { type: 'string', minLength: 4, maxLength: 160, allOf: [{ minLength: 6 }] },
    site: { type: 'string', format: 'uri' },
    plan: { type: 'string', enum: ['free', 'pro'], default: 'free' },
    address: { type: 'object', properties: { street: { type: 'string', minLength: 3 }, zip: { type: 'string', pattern: '^[0-9]{5}$' } }, required: ['street', 'zip'], additionalProperties: false },
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 3 },
  },
  required: ['username', 'email', 'address'],
}`
const SOURCE = `import { ataResolver } from '@hookform/resolvers/ata-validator'
export const Signup = ${SCHEMA}
export const resolve = ataResolver(Signup)
export const resolveRaw = ataResolver(Signup, undefined, { raw: true })
`
const DOCS = [
  { username: 'ayse', email: 'ayse@example.com', address: { street: 'Bagdat', zip: '34710' } },
  { username: 'ayse', email: 'ayse@example.com', address: { street: 'Bagdat', zip: '34710' }, site: 'https://example.com', plan: 'pro', tags: ['a', 'b'] },
  { username: 'A', email: 'nope', bio: 'x', site: 'not a uri', plan: 'gold', address: { street: 'ab', zip: '12a', extra: 1 }, tags: ['', 'b', 'c', 'd'] },
  { email: 'x@y.z', address: {} },
  { username: 'ayse', email: 'a@b.co' },
  { username: 5, email: null, address: 'x', tags: 'y' },
  {},
]
const OPTIONS = [
  { fields: {}, shouldUseNativeValidation: false },
  { fields: {}, shouldUseNativeValidation: false, criteriaMode: 'all' },
  { fields: {}, shouldUseNativeValidation: false, criteriaMode: 'firstError' },
]

describe('compileAway: its own compiled resolver', () => {
  let dir
  before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'resolver-own-')); await fs.writeFile(path.join(dir, 'form.js'), SOURCE) })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

  it('replaces ataResolver, leaves the Validator out, and answers as the package does', async () => {
    const { build } = await import('esbuild')
    const out = path.join(dir, 'out.mjs')
    await build({ absWorkingDir: dir, entryPoints: ['form.js'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', plugins: [esbuildPlugin({ verify: false, report: false })] })
    const text = await fs.readFile(out, 'utf8')
    assert.match(text, /__ataCompiledResolver/, 'the call was not replaced')
    assert.doesNotMatch(text, /class Validator\b/, 'the bundle still carries the Validator')
    const built = await import(pathToFileURL(out).href)
    const schema = built.Signup
    let n = 0
    for (const [name, runtime] of [['resolve', ataResolver(schema)], ['resolveRaw', ataResolver(schema, undefined, { raw: true })]]) {
      for (const d of DOCS) {
        for (const o of OPTIONS) {
          const want = await runtime(structuredClone(d), undefined, o)
          const got = await built[name](structuredClone(d), undefined, o)
          assert.equal(JSON.stringify(got), JSON.stringify(want), `${name} on ${JSON.stringify(d)} with ${JSON.stringify(o)}`)
          n++
        }
      }
    }
    assert.equal(n, 2 * DOCS.length * OPTIONS.length)
    // `raw` hands back a copy, the default hands back the object it was given.
    const doc = structuredClone(DOCS[0])
    assert.equal((await built.resolve(doc, undefined, OPTIONS[0])).values, doc)
    assert.notEqual((await built.resolveRaw(doc, undefined, OPTIONS[0])).values, doc)
  })
})
