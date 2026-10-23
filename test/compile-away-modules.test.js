// A schema compiled away only when the value read at build time is the one the
// runtime gets: a constant changed after it is written (in its file, under a
// second name, or by a call) stays on the runtime, and a schema imported from
// another JavaScript or TypeScript module is read from that module by the
// same rules. Each case runs the original and the rewritten module on the same
// documents and compares the answers.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let dir
let ata
let n = 0

before(async () => {
  ata = await __internal.loadAta()
  dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-modules-'))
})
after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// Writes `files` into a fresh folder, rewrites `entry`, and returns whether the
// call was replaced and both modules' answers on `docs`.
async function run(files, docs, entry = 'entry.mjs') {
  const sub = path.join(dir, String(n++))
  await fs.mkdir(sub, { recursive: true })
  for (const [name, code] of Object.entries(files)) await fs.writeFile(path.join(sub, name), code)
  const file = path.join(sub, entry)
  const out = compileAway(files[entry], file, ata, {})
  const original = await import(pathToFileURL(file).href)
  let rewritten = original
  if (out) {
    const outFile = path.join(sub, 'out.mjs')
    await fs.writeFile(outFile, out.code)
    rewritten = await import(pathToFileURL(outFile).href)
  }
  const answers = (m) => docs.map((d) => JSON.stringify(m.check(structuredClone(d))))
  return { replaced: out !== null && !out.code.includes("new Validator("), original: answers(original), rewritten: answers(rewritten) }
}

const DOCS = [{}, { n: 1 }, { n: 'x' }, { n: 1, extra: true }]
const ENTRY = (schemaExpr, before = '') => `import { Validator } from 'ata-validator'
${before}
const v = new Validator(${schemaExpr})
export const check = (d) => v.validate(d).valid
`

describe('a schema changed after it is written stays on the runtime', () => {
  for (const [name, code] of [
    ['a property set afterwards', ENTRY('schema', "const schema = { type: 'object', properties: { n: { type: 'integer' } } }\nschema.required = ['n']")],
    ['changed under a second name', ENTRY('schema', "const schema = { type: 'object', properties: { n: { type: 'integer' } } }\nconst alias = schema\nalias.required = ['n']")],
    ['handed to a function', ENTRY('schema', "const schema = { type: 'object', properties: { n: { type: 'integer' } } }\nfunction strict(s) { s.required = ['n'] }\nstrict(schema)")],
    ['a nested schema changed', ENTRY('schema', "const inner = { type: 'integer' }\nconst schema = { type: 'object', properties: { n: inner }, required: ['n'] }\ninner.minimum = 5")],
  ]) {
    it(name, async () => {
      const r = await run({ 'entry.mjs': code }, DOCS)
      assert.equal(r.replaced, false)
      assert.deepEqual(r.rewritten, r.original)
    })
  }

  it('still compiles a constant used only as the schema, nested or not', async () => {
    const r = await run({ 'entry.mjs': ENTRY('schema', "const inner = { type: 'integer' }\nconst schema = { type: 'object', properties: { n: inner }, required: ['n'] }") }, DOCS)
    assert.equal(r.replaced, true)
    assert.deepEqual(r.rewritten, r.original)
  })
})

describe('a schema imported from another module', () => {
  const SCHEMA = "{ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }"

  it('a named export', async () => {
    const r = await run({
      'schemas.mjs': `export const Item = ${SCHEMA}\n`,
      'entry.mjs': ENTRY('Item', "import { Item } from './schemas.mjs'"),
    }, DOCS)
    assert.equal(r.replaced, true)
    assert.deepEqual(r.rewritten, r.original)
  })

  it('a default export, renamed on import', async () => {
    const r = await run({
      'schemas.mjs': `export default ${SCHEMA}\n`,
      'entry.mjs': ENTRY('Thing', "import Thing from './schemas.mjs'"),
    }, DOCS)
    assert.equal(r.replaced, true)
    assert.deepEqual(r.rewritten, r.original)
  })

  it('through a re-export and a local export list', async () => {
    const r = await run({
      'base.mjs': `const Inner = ${SCHEMA}\nexport { Inner as Item }\n`,
      'index.mjs': "export { Item } from './base.mjs'\n",
      'entry.mjs': ENTRY('Item', "import { Item } from './index.mjs'"),
    }, DOCS)
    assert.equal(r.replaced, true)
    assert.deepEqual(r.rewritten, r.original)
  })

  it('a TypeScript module named with .js, as TypeScript imports are written', () => {
    const sub = path.join(dir, 'ts')
    return fs.mkdir(sub, { recursive: true }).then(async () => {
      await fs.writeFile(path.join(sub, 'schemas.ts'), `export const Item = ${SCHEMA} as const\n`)
      const code = ENTRY('Item', "import { Item } from './schemas.js'")
      const out = compileAway(code, path.join(sub, 'entry.ts'), ata, {})
      assert.ok(out && !out.code.includes('new Validator('))
      // The import stays, so the bundler still sees the file and rebuilds when it changes.
      assert.ok(out.code.includes("from './schemas.js'"))
    })
  })

  it('stays on the runtime when the defining module changes the schema', async () => {
    const r = await run({
      'schemas.mjs': `export const Item = { type: 'object', properties: { n: { type: 'integer' } } }\nItem.required = ['n']\n`,
      'entry.mjs': ENTRY('Item', "import { Item } from './schemas.mjs'"),
    }, DOCS)
    assert.equal(r.replaced, false)
    assert.deepEqual(r.rewritten, r.original)
  })

  it('stays on the runtime when the importing module changes it', async () => {
    const r = await run({
      'schemas.mjs': `export const Item = { type: 'object', properties: { n: { type: 'integer' } } }\n`,
      'entry.mjs': ENTRY('Item', "import { Item } from './schemas.mjs'\nItem.required = ['n']"),
    }, DOCS)
    assert.equal(r.replaced, false)
    assert.deepEqual(r.rewritten, r.original)
  })

  it('stays on the runtime for a value the build cannot read, and for a cycle', async () => {
    const computed = await run({
      'schemas.mjs': "const max = Number(process.env.MAX || 5)\nexport const Item = { type: 'integer', maximum: max }\n",
      'entry.mjs': ENTRY('Item', "import { Item } from './schemas.mjs'"),
    }, [1, 9])
    assert.equal(computed.replaced, false)
    // A re-export cycle: Node refuses to load it, so only the rewrite is checked.
    const sub = path.join(dir, 'cycle')
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, 'a.mjs'), "export { Item } from './b.mjs'\n")
    await fs.writeFile(path.join(sub, 'b.mjs'), "export { Item } from './a.mjs'\n")
    assert.equal(compileAway(ENTRY('Item', "import { Item } from './a.mjs'"), path.join(sub, 'entry.mjs'), ata, {}), null)
  })
})
