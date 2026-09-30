// compileAway with the ata-validator/t builder: a schema built with t.*(...)
// calls whose arguments the build can read is evaluated at build time with
// the same builder, the calls are marked pure, and the built output answers
// exactly as the runtime does. Calls that take a function stay on the runtime.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import unplugin from '../src/index.js'
import { compileAway } from '../src/compile-away.js'

const require = createRequire(import.meta.url)
const { Validator } = require('ata-validator')
const { t } = require('ata-validator/t')
const ata = { ...require('ata-validator/build'), t }

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'fixtures', 'compile-away-t')
const entry = path.join(root, 'entry.mjs')

describe('compileAway reads the t builder', () => {
  const head = "import { Validator } from 'ata-validator'\nimport { t } from 'ata-validator/t'\n"
  const file = path.join(root, 'x.ts')

  it('evaluates builder calls and marks them pure', () => {
    const out = compileAway(head + "const S = t.object({ a: t.string({ minLength: 1 }), b: t.optional(t.number()) })\nconst v = new Validator(S)\nexport const f = (x) => v.validate(x)\n", file, ata)
    assert.ok(out, 'nothing was replaced')
    assert.ok(out.code.includes('/*#__PURE__*/ t.object('), 'the builder call is marked pure')
    assert.ok(out.code.includes(JSON.stringify(new Validator(t.object({ a: t.string({ minLength: 1 }), b: t.optional(t.number()) }))._schemaObj)) || out.code.includes('"required":["a"]'), 'the schema t builds is what was compiled')
  })

  it('leaves a schema with t.refine on the runtime', () => {
    const code = head + "const S = t.refine(t.string(), (s) => s.length > 1)\nconst v = new Validator(S)\nexport const f = (x) => v.validate(x)\n"
    assert.equal(compileAway(code, file, ata), null)
  })

  it('leaves a t that is not the builder', () => {
    const code = "import { Validator } from 'ata-validator'\nconst t = { string: () => ({ type: 'number' }) }\nconst v = new Validator(t.string())\nexport const f = (x) => v.validate(x)\n"
    assert.equal(compileAway(code, file, ata), null)
  })

  it('leaves builder calls with arguments the build cannot read', () => {
    const code = head + "const n = Math.random()\nconst v = new Validator(t.string({ maxLength: n }))\nexport const f = (x) => v.validate(x)\n"
    assert.equal(compileAway(code, file, ata), null)
  })
})

describe('compileAway with the t builder in a bundle', () => {
  it('answers as new Validator does, and the builder leaves the bundle', async () => {
    const esbuild = await import('esbuild')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-t-'))
    const out = path.join(dir, 'out.mjs')
    // Schemas only the validator uses take the builder with them. The entry
    // below exports its schemas for the comparison, so it keeps them.
    const browser = await esbuild.build({ entryPoints: [path.join(root, 'app.mjs')], absWorkingDir: root, bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent', plugins: [unplugin.esbuild({ schemas: 'none/*.json' })] })
    const min = new TextDecoder().decode(browser.outputFiles[0].contents)
    assert.ok(!min.includes('ata.t.optional'), 'the t builder is still in the bundle')
    assert.ok(!min.includes('items ## '), 'the runtime is still in the bundle')
    await esbuild.build({ entryPoints: [entry], absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', outfile: out, plugins: [unplugin.esbuild({ schemas: 'none/*.json' })], logLevel: 'silent' })
    const src = await fs.readFile(out, 'utf8')
    assert.ok(src.includes('__ataCompiled0') && src.includes('__ataCompiled2'), 'all three calls were replaced')
    const mod = await import(pathToFileURL(out).href)
    const user = new Validator(mod.User), pub = new Validator(mod.Public), patch = new Validator(mod.Patch)
    const good = { id: 1, name: 'Mert', role: 'admin', status: 'active', tags: ['a'], point: [1, 2], meta: { x: true }, address: { street: 's' }, note: null }
    const docs = [
      good,
      { ...good, nick: 'm', address: { street: 's', zip: '12345' } },
      { ...good, id: 0, role: 'root', status: 'gone', tags: ['a', 'b', 'c', 'd'], point: [1], meta: { x: 1 }, address: { zip: 'x' }, note: 5 },
      { ...good, point: [1, 2, 3] },
      {},
      null,
    ]
    for (const d of docs) {
      assert.equal(JSON.stringify(mod.validate(structuredClone(d))), JSON.stringify(user.validate(structuredClone(d))), `validate ${JSON.stringify(d)}`)
      assert.equal(mod.isValidObject(structuredClone(d)), user.isValidObject(structuredClone(d)))
      assert.equal(JSON.stringify(mod.validateJSON(JSON.stringify(d))), JSON.stringify(user.validateJSON(JSON.stringify(d))))
      assert.equal(mod.pubOk(structuredClone(d)), pub.isValidObject(structuredClone(d)))
      assert.equal(JSON.stringify(mod.patchCheck(structuredClone(d))), JSON.stringify(patch.validate(structuredClone(d))))
    }
    assert.equal(mod.isValidObject(good), true, 'the valid document is valid, or nothing was tested')
    assert.equal(mod.isValidObject(docs[2]), false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
