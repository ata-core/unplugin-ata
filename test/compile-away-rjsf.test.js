// compileAway for rjsf: `<Form schema={schema} validator={validator} />`, with
// `validator` the default import of @rjsf/validator-ata and a schema the build
// can read, gets a precompiled validator written by rjsf's own
// compileSchemaValidatorsCode, in the runtime's error order, filling defaults
// before the check as the runtime does. The rjsf packages
// here are stand-ins written by the test, the shape of the real ones: the
// module writer calls ata-validator's bundleStandalone as rjsf does, and
// createPrecompiledValidator hands back what it was given, so the test can run
// the module against `new Validator(schema)`. rjsf's own tests hold its
// precompiled validator to its runtime one.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
// The ata-validator the stand-in compiles with: this package's, or another
// checkout through RJSF_TEST_ATA.
const ataDir = process.env.RJSF_TEST_ATA || path.dirname(require.resolve('ata-validator'))
const { Validator } = createRequire(path.join(ataDir, 'index.js'))('./index.js')
const ordered = (() => {
  try { return /function _ataOrder\(/.test(Validator.bundleStandalone([{ type: 'object', additionalProperties: false }], { order: true })) } catch { return false }
})()
const needsOrder = ordered ? false : 'needs an ata-validator whose bundleStandalone takes order and useDefaults (1.59.0)'

let dir
let ata
let n = 0

const COMPILER = `const { Validator } = require('ata-validator')
exports.compileSchemaValidatorsCode = (schema) => {
  const bundle = Validator.bundleStandalone([{ ...schema, $id: 'root' }], { format: 'cjs', verbose: true })
  return 'const validators = (function () {\\n  const module = { exports: {} };\\n' + bundle + '\\n  return module.exports;\\n})();\\nmodule.exports = { root: validators[0] };\\n'
}
`

async function writePackages(root, ataTarget) {
  const rjsf = path.join(root, 'node_modules', '@rjsf', 'validator-ata')
  await fs.mkdir(path.join(rjsf, 'lib'), { recursive: true })
  await fs.mkdir(path.join(rjsf, 'dist'), { recursive: true })
  await fs.writeFile(path.join(rjsf, 'package.json'), JSON.stringify({
    name: '@rjsf/validator-ata', version: '0.0.0-test', type: 'module',
    exports: {
      '.': { import: './lib/index.js' },
      './compileSchemaValidators': { import: './lib/compileSchemaValidators.js', require: './dist/compileSchemaValidators.cjs' },
      './lib/*.js': { import: './lib/*.js', require: './dist/*.cjs' },
    },
  }))
  await fs.writeFile(path.join(rjsf, 'lib', 'index.js'), "export default { runtime: true, marker: 'rjsf runtime ## ' }\n")
  await fs.writeFile(path.join(rjsf, 'lib', 'createPrecompiledValidator.js'), 'export default function createPrecompiledValidator(fns, root) { return { fns, root } }\n')
  await fs.writeFile(path.join(rjsf, 'dist', 'compileSchemaValidators.cjs'), COMPILER)
  const core = path.join(root, 'node_modules', '@rjsf', 'core')
  await fs.mkdir(core, { recursive: true })
  await fs.writeFile(path.join(core, 'package.json'), JSON.stringify({ name: '@rjsf/core', version: '0.0.0-test', type: 'module', exports: { '.': './index.js' } }))
  await fs.writeFile(path.join(core, 'index.js'), 'export default function Form() {}\n')
  await fs.symlink(ataTarget, path.join(root, 'node_modules', 'ata-validator'), 'dir')
}

before(async () => {
  dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-rjsf-'))
  await writePackages(dir, ataDir)
  ata = await __internal.loadAta()
})
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const SCHEMA = "{ type: 'object', required: ['email', 'name'], properties: { email: { type: 'string', format: 'email' }, name: { type: 'string', minLength: 2 }, age: { type: 'integer', minimum: 13 } }, additionalProperties: false }"
const ENTRY = ({ before = '', schema = 'schema', attrs = '', tag = 'Form', imports = "import Form from '@rjsf/core'" } = {}) => `${imports}
import validator from '@rjsf/validator-ata'
const h = (type, props) => ({ type, props })
const schema = ${SCHEMA}
${before}
export const el = <${tag} schema={${schema}} validator={validator}${attrs} />
export { schema }
`

function rewrite(code, root = dir) {
  const file = path.join(root, `entry-${n++}.jsx`)
  return { out: compileAway(code, file, ata, {}), file }
}

// Bundles the rewritten entry and returns its exports.
async function run(code, file) {
  const src = path.join(path.dirname(file), `rewritten-${n++}.jsx`)
  const out = src.replace(/\.jsx$/, '.mjs')
  await fs.writeFile(src, code)
  await esbuild.build({ entryPoints: [src], bundle: true, format: 'esm', platform: 'node', outfile: out, jsx: 'transform', jsxFactory: 'h', logLevel: 'error', absWorkingDir: path.dirname(file) })
  return import(pathToFileURL(out).href)
}

const DOCS = [{}, { email: 'a@b.co', name: 'Al' }, { email: 'x', name: 'A', age: 3, extra: 1 }, { email: 'a@b.co', name: '😀', age: 13.5 }, { name: 1, extra: true, email: null }, null, 'nope']

describe('rjsf form validators compiled away', () => {
  it('a form with a schema the build can read gets a precompiled validator, errors in the runtime order', { skip: needsOrder }, async () => {
    const { out, file } = rewrite(ENTRY())
    assert.ok(out, 'rewritten')
    assert.ok(!out.code.includes("from '@rjsf/validator-ata'"), 'the runtime validator import is gone')
    assert.ok(out.code.includes("from '@rjsf/validator-ata/lib/createPrecompiledValidator.js'"))
    const mod = await run(out.code, file)
    const { fns, root } = mod.el.props.validator
    assert.deepEqual(root, mod.schema, 'the root schema is the form schema')
    const runtime = new Validator(mod.schema, { useDefaults: false, verbose: true })
    for (const d of DOCS) {
      const a = runtime.validate(structuredClone(d))
      const b = fns.root(structuredClone(d))
      const shape = (r) => JSON.stringify({ valid: r.valid, errors: (r.errors || []).map((e) => [e.keyword, e.instancePath, e.schemaPath, e.message]) })
      assert.equal(shape(b), shape(a), JSON.stringify(d))
    }
  })

  it('fills defaults as the runtime does, on a copy of the form data', { skip: needsOrder }, async () => {
    const schema = "{ type: 'object', required: ['plan', 'name'], properties: { name: { type: 'string', minLength: 2 }, plan: { type: 'string', enum: ['free', 'pro'], default: 'free' }, seats: { type: 'integer', default: 1, minimum: 1 } } }"
    const { out, file } = rewrite(ENTRY({ schema: 'formSchema', before: `const formSchema = ${schema}` }))
    assert.ok(out && out.code.includes('__ataRjsf0'), 'rewritten')
    const mod = await run(out.code, file)
    const { fns } = mod.el.props.validator
    const runtime = new Validator(mod.el.props.schema, { verbose: true })
    for (const d of [{ name: 'Al' }, {}, { name: 'A', seats: 0 }, { name: 'Al', plan: 'gold' }]) {
      // rjsf's runtime validator checks a copy (cloneForValidation): the form's data stays as it was.
      const b = structuredClone(d)
      const ra = runtime.validate(structuredClone(d)), rb = fns.root(b)
      assert.deepEqual(b, d, `the form's data is not changed: ${JSON.stringify(d)}`)
      assert.equal(JSON.stringify(rb.errors.map((e) => e.schemaPath)), JSON.stringify(ra.errors.map((e) => e.schemaPath)), JSON.stringify(d))
      assert.equal(rb.valid, ra.valid)
    }
  })

  it('reads a schema imported from another module', { skip: needsOrder }, async () => {
    await fs.writeFile(path.join(dir, 'schemas.mjs'), `export const Signup = ${SCHEMA}\n`)
    const code = `import Form from '@rjsf/core'
import validator from '@rjsf/validator-ata'
import { Signup } from './schemas.mjs'
const h = (type, props) => ({ type, props })
export const el = <Form schema={Signup} validator={validator} />
`
    const { out } = rewrite(code)
    assert.ok(out && out.code.includes('__ataRjsf0'))
  })

  it('keeps the import while something else uses the runtime validator', { skip: needsOrder }, () => {
    const { out } = rewrite(ENTRY({ before: 'export const other = validator' }))
    assert.ok(out && out.code.includes('__ataRjsf0'))
    assert.ok(out.code.includes("import validator from '@rjsf/validator-ata'"))
  })

  for (const [name, opts] of [
    ['a spread attribute', { attrs: ' {...rest}', before: 'const rest = {}' }],
    ['a component that is not an rjsf form', { tag: 'MyForm', imports: 'function MyForm() {}' }],
    ['a schema changed after it is written', { before: "schema.required = ['age']" }],
    ['a schema the build cannot read', { schema: 'makeSchema()', before: 'function makeSchema() { return {} }' }],
  ]) {
    it(`stays on the runtime for ${name}`, () => {
      const { out } = rewrite(ENTRY(opts))
      assert.ok(!out || !out.code.includes('__ataRjsf'), 'not rewritten')
    })
  }

  it('stays on the runtime where the ata-validator rjsf compiles with cannot write the runtime order', async () => {
    const old = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-rjsf-old-'))
    try {
      const fake = path.join(old, 'fake-ata')
      await fs.mkdir(fake, { recursive: true })
      await fs.writeFile(path.join(fake, 'package.json'), JSON.stringify({ name: 'ata-validator', version: '1.58.1', main: 'index.js' }))
      await fs.writeFile(path.join(fake, 'index.js'), "exports.Validator = { bundleStandalone: () => 'function _cpLen(s) { return s.length }\\nmodule.exports = [function () { return { valid: true, errors: [] } }];' }\n")
      await writePackages(old, fake)
      const { out } = rewrite(ENTRY(), old)
      assert.ok(!out || !out.code.includes('__ataRjsf'), 'not rewritten')
    } finally {
      await fs.rm(old, { recursive: true, force: true })
    }
  })
})
