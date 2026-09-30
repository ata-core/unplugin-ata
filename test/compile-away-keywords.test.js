// compileAway with @ata-project/keywords: `withKeywords(new Validator(schema))`
// has its inner call replaced, withKeywords registers the keywords' check on
// the compiled wrapper, and the built output answers exactly as the runtime
// does, errors included. The decision rules come first, since a wrong
// replacement would be silent.

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
const { withKeywords } = require('@ata-project/keywords')
const ata = require('ata-validator/build')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'fixtures', 'compile-away-keywords')
const entry = path.join(root, 'entry.mjs')
const RUNTIME_MARKER = 'items ## '

describe('compileAway with withKeywords', () => {
  const head = "import { Validator } from 'ata-validator'\nimport { withKeywords } from '@ata-project/keywords'\n"
  const file = path.join(root, 'k.ts')
  const code = head + "const v = withKeywords(new Validator({ type: 'object', properties: { at: { instanceof: 'Date' } } }))\nexport const f = (x) => v.validate(x)\n"

  it('replaces the inner call when the wrappers take the check', () => {
    const out = compileAway(code, file, { ...ata, compiledExtendChecks: true })
    assert.ok(out, 'nothing was replaced')
    assert.ok(out.code.includes('withKeywords(__ataFromCompiled('), 'withKeywords stays around the compiled wrapper')
    assert.ok(!/from 'ata-validator'/.test(out.code), 'the runtime import goes')
  })

  it('leaves it alone with an ata-validator whose wrappers do not', () => {
    assert.equal(compileAway(code, file, { ...ata, compiledExtendChecks: false }), null)
  })

  it('leaves a withKeywords that is not the package one', () => {
    const local = "import { Validator } from 'ata-validator'\nconst withKeywords = (v) => v\nconst v = withKeywords(new Validator({ type: 'integer' }))\nexport const f = (x) => v.validate(x)\n"
    assert.equal(compileAway(local, file, { ...ata, compiledExtendChecks: true }), null)
  })

  it('leaves it when the wrapped validator is used another way', () => {
    const other = head + "const v = withKeywords(new Validator({ type: 'integer' }))\nexport const f = (x) => v.validate(x)\nexport const g = () => v\n"
    assert.equal(compileAway(other, file, { ...ata, compiledExtendChecks: true }), null)
  })
})

describe('compileAway with withKeywords in a bundle', () => {
  it('answers as withKeywords(new Validator) does', async () => {
    const esbuild = await import('esbuild')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-kw-'))
    const out = path.join(dir, 'out.mjs')
    await esbuild.build({ entryPoints: [entry], absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', outfile: out, plugins: [unplugin.esbuild({ schemas: 'none/*.json' })], logLevel: 'silent' })
    const src = await fs.readFile(out, 'utf8')
    assert.ok(!src.includes(RUNTIME_MARKER), 'the build still carries the runtime')
    assert.ok(src.includes('__ataCompiled0') && src.includes('__ataCompiled1'), 'both calls were replaced')
    const mod = await import(pathToFileURL(out).href)
    const runtime = withKeywords(new Validator(mod.Product))
    const atRuntime = withKeywords(new Validator({ type: 'object', properties: { at: { instanceof: 'Date' } } }))
    const img = (created) => ({ id: 1, created, title: 'a' })
    const docs = [
      () => ({ id: 1, created: new Date(0), title: 'x', images: [img(new Date(1))] }),
      () => ({ id: 1, created: {}, title: 'x', images: [] }),
      () => ({ id: 1, created: new Date(0), title: 'x', images: [img({}), img(new Date(2))] }),
      () => ({ id: 'x', created: {}, title: '', images: [img('no')] }),
      () => ({ id: 1, title: 'x', images: [] }),
      () => null,
    ]
    let keywordOnly = 0
    for (const make of docs) {
      const a = JSON.stringify(runtime.validate(make())), b = JSON.stringify(mod.validate(make()))
      assert.equal(b, a, `validate ${a}`)
      assert.equal(mod.isValidObject(make()), runtime.isValidObject(make()))
      const text = JSON.stringify(make())
      assert.equal(JSON.stringify(mod.validateJSON(text)), JSON.stringify(runtime.validateJSON(text)), `validateJSON ${text}`)
      assert.equal(mod.isValidJSON(text), runtime.isValidJSON(text), `isValidJSON ${text}`)
      if (new Validator(JSON.parse(JSON.stringify(mod.Product))).isValidObject(make()) && !runtime.isValidObject(make())) keywordOnly++
    }
    assert.ok(keywordOnly >= 2, 'the keyword alone rejects some documents, or nothing was tested')
    for (const d of [{ at: new Date() }, { at: {} }, {}]) assert.equal(mod.atOk(d), atRuntime.isValidObject(d))
    await fs.rm(dir, { recursive: true, force: true })
  })
})
