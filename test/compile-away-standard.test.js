// A validator handed only to a Standard Schema consumer the build knows
// (`sValidator('json', v)` from @hono/standard-validator) takes the wrapper
// that carries `~standard` alone, on a module with plain errors: no error
// pipeline in the bundle. The decision rules first, then the built output
// against the runtime's `~standard`, issue for issue.

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
const ata = require('ata-validator/build')
const can = await import('ata-validator/compiled-standard').then((m) => typeof m.bareStandard === 'function', () => false)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'fixtures', 'compile-away-standard')
const file = path.join(root, 'app.ts')
const SCHEMA = "{ type: 'object', required: ['email', 'age'], additionalProperties: false, properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer', minimum: 13 }, newsletter: { type: 'boolean', default: false } } }"
const head = "import { Validator } from 'ata-validator'\nimport { sValidator } from '@hono/standard-validator'\n"
const opts = { ...ata, compiledStandard: true, compiledStandardWrapper: can, compiledObject: true, compiledBare: true, compiledBareRich: true, compiledVerdict: true, compiledPlain: true }

describe('compileAway with a Standard Schema consumer', { skip: can ? false : 'ata-validator without compiled-standard' }, () => {
  it('takes the Standard-only wrapper and a plain-errors module', () => {
    const out = compileAway(head + `const user = new Validator(${SCHEMA})\nexport const check = sValidator('json', user)\n`, file, opts)
    assert.ok(out, 'nothing was replaced')
    assert.ok(out.code.includes("from 'ata-validator/compiled-standard'"), out.code.slice(0, 300))
    assert.ok(out.code.includes('__ataBareStandard(__ataCompiled0, {'), 'the wrapper takes the module and the schema as written')
    assert.ok(!/from 'ata-validator'/.test(out.code), 'the runtime import goes')
    assert.ok(!out.code.includes('_ataStamp'), 'the module writes plain errors, no code or docUrl stamp')
  })

  it('works through a namespace import and with useDefaults: false', () => {
    const code = "import { Validator } from 'ata-validator'\nimport * as sv from '@hono/standard-validator'\n" + `const user = new Validator(${SCHEMA}, { useDefaults: false })\nexport const check = sv.sValidator('json', user)\n`
    const out = compileAway(code, file, opts)
    assert.ok(out && out.code.includes('__ataBareStandard(__ataCompiled0, {') && out.code.includes('}, false)'), out && out.code.slice(0, 400))
  })

  it('keeps the wrapper with errors when the code also calls the validator', () => {
    const out = compileAway(head + `const user = new Validator(${SCHEMA})\nexport const check = sValidator('json', user)\nexport const why = (d) => user.validate(d).errors\n`, file, opts)
    assert.ok(out && !out.code.includes('__ataBareStandard'), 'own calls need the errors')
    assert.ok(out.code.includes('__ataFromCompiledObject(') || out.code.includes('__ataFromCompiled('), out.code.slice(0, 300))
  })

  it('treats a consumer the build does not know as any handover', () => {
    const code = "import { Validator } from 'ata-validator'\nimport { takes } from './somewhere.js'\n" + `const user = new Validator(${SCHEMA})\nexport const check = takes(user)\n`
    const out = compileAway(code, file, opts)
    assert.ok(out && !out.code.includes('__ataBareStandard') && out.code.includes('__ataFromCompiledObject('), out && out.code.slice(0, 300))
    // Unless the options name it.
    const named = compileAway(code, file, opts, { standardConsumers: ['./somewhere.js'] })
    assert.ok(named && named.code.includes('__ataBareStandard'), 'standardConsumers adds a package')
  })

  it('keeps it on the runtime with an ata-validator that has no such wrapper', () => {
    const out = compileAway(head + `const user = new Validator(${SCHEMA})\nexport const check = sValidator('json', user)\n`, file, { ...opts, compiledStandardWrapper: false })
    assert.ok(out && !out.code.includes('__ataBareStandard'), 'falls back to the wrapper with ~standard')
  })

  it('answers as the runtime through the consumer, issues included', async () => {
    const esbuild = await import('esbuild')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-std-'))
    const entry = path.join(root, 'entry.mjs')
    await fs.writeFile(entry, head + `const user = new Validator(${SCHEMA})\nexport const check = sValidator('json', user)\nexport const schema = ${SCHEMA}\n`)
    const out = path.join(dir, 'out.mjs')
    await esbuild.build({ entryPoints: [entry], absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', outfile: out, plugins: [unplugin.esbuild({ schemas: 'none/*.json', verify: false, report: false })], logLevel: 'silent' })
    const src = await fs.readFile(out, 'utf8')
    assert.ok(!src.includes('items ## '), 'the build still carries the runtime')
    assert.ok(!src.includes('docUrl'), 'the build carries the error pipeline')
    const mod = await import(pathToFileURL(out).href)
    const runtime = new Validator(mod.schema)['~standard']
    const show = (r) => JSON.stringify('issues' in r ? r.issues.map((i) => [i.message, i.path.map((p) => p.key)]) : ['value', r.value])
    for (const doc of [{ email: 'a@b.co', age: 20 }, { email: 'nope', age: 5, x: 1 }, { age: 'x' }, {}, null, [], { email: 'a@b.co', age: 13, newsletter: true }]) {
      const a = structuredClone(doc), b = structuredClone(doc)
      assert.equal(show(mod.check(a)), show(runtime.validate(b)), JSON.stringify(doc))
      assert.equal(JSON.stringify(a), JSON.stringify(b), 'defaults filled alike: ' + JSON.stringify(doc))
    }
    await fs.rm(entry, { force: true })
    await fs.rm(dir, { recursive: true, force: true })
  })
})
