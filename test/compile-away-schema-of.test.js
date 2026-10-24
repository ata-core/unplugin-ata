// `schemaOf<T>()`: the JSON Schema of a TypeScript type, read with the
// TypeScript checker at build time and written into the code; a
// `new Validator(schemaOf<T>())` then compiles away like any static schema.
// The answers are held to a runtime Validator built from the same schema. A
// call the build cannot answer stops the build rather than leaving a call
// that throws on load.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import unplugin from '../src/index.js'
import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'fixtures', 'schema-of')
const entry = path.join(root, 'entry.ts')
const ata = await __internal.loadAta()
const types = __internal.createTypeSchemas({})
await types.ready()

const DOCS = [
  { id: 7, email: 'ada@example.com', name: 'Ada', role: 'user' },
  { id: '7', name: 'Ada' },
  { id: 0, email: 'nope', name: '', role: 'root', age: 12.5, tags: ['a', 'b', 'c', 'd'], address: { street: 'x', zip: '12a' }, extra: 1 },
  { id: 7, email: 'a@b.co', name: 'A', role: 'admin', age: 13, address: { street: 'x', zip: '34000' } },
  null, 'nope',
]
const shape = (r) => JSON.stringify({ valid: r.valid, errors: (r.errors || []).map((e) => [e.keyword, e.instancePath]).sort() })

describe('schemaOf<T>()', () => {
  it('reads the type and its JSDoc tags into a schema the runtime agrees with', () => {
    const schema = types.schemaFor(entry, 'User')
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, ['id', 'email', 'name', 'role'])
    assert.equal(schema.properties.email.format, 'email')
    assert.equal(schema.properties.age.type, 'integer')
    assert.equal(schema.properties.address.properties.zip.pattern, '^[0-9]{5}$')
  })

  it('replaces the call and compiles the validator away', async () => {
    const code = await fs.readFile(entry, 'utf8')
    const out = compileAway(code, entry, ata, { typeSchema: types.schemaFor })
    assert.ok(out, 'rewritten')
    assert.ok(!out.code.includes('schemaOf'), 'no schemaOf left')
    assert.ok(!out.code.includes("from 'ata-validator'"), 'the runtime import is gone')
    assert.ok(out.code.includes('JSON.parse('), 'the bare schemaOf call became the schema')
  })

  it('bundles with esbuild through the plugin and answers as the runtime does', async () => {
    const esbuild = await import('esbuild')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-schema-of-'))
    const outfile = path.join(dir, 'out.mjs')
    await esbuild.build({ entryPoints: [entry], absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', outfile, plugins: [unplugin.esbuild({ schemas: 'none/*.json' })], logLevel: 'silent' })
    const src = await fs.readFile(outfile, 'utf8')
    assert.doesNotMatch(src, /from\s+['"]ata-validator|new Function/, 'no runtime, no new Function')
    const mod = await import(pathToFileURL(outfile).href)
    const runtime = new ata.Validator(mod.schema, { useDefaults: false })
    for (const d of DOCS) assert.equal(shape(mod.check(structuredClone(d))), shape(runtime.validate(structuredClone(d))), JSON.stringify(d))
    assert.equal(mod.check({ id: '7', name: 'Ada' }).valid, false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  for (const [name, code, message] of [
    ['an inline type literal', "import { schemaOf } from 'ata-validator'\nexport const s = schemaOf<{ a: number }>()\n", /named type/],
    ['a type the checker does not find', "import { schemaOf } from 'ata-validator'\nexport const s = schemaOf<Nope>()\n", /Nope/],
    ['a value argument', "import { schemaOf } from 'ata-validator'\nexport const s = schemaOf<User>(1)\n", /no value/],
    ['a use that is not a call', "import { schemaOf } from 'ata-validator'\nexport const f = schemaOf\n", /only replaced as a call/],
  ]) {
    it(`stops the build for ${name}`, () => {
      assert.throws(() => compileAway(code, path.join(root, 'bad.ts'), ata, { typeSchema: types.schemaFor }), message)
    })
  }

  it('stops the build when the generator is not available', () => {
    const code = "import { schemaOf } from 'ata-validator'\nexport const s = schemaOf<User>()\n"
    assert.throws(() => compileAway(code, entry, ata, {}), /ts-json-schema-generator/)
  })
})
