// compileAway for react-hook-form: `ataResolver(schema)` from
// @hookform/resolvers/ata-validator, with a schema the build can read, becomes
// `ataCompiledResolver(module)`, and the built resolver must answer exactly as
// `ataResolver(schema)` does: the values (defaults filled in) and the errors,
// in order, compared as JSON. The resolvers package here is a stand-in written
// by the test, the shape of the real one, returning every error with the
// fields a resolver reads (the real one takes keyword, instancePath, message
// and params from each, in order), so a difference in order or content shows.
// The runtime's enrichment (hints, received values) is not among them.

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import unplugin from '../src/index.js'
import { compileAway } from '../src/compile-away.js'

const require = createRequire(import.meta.url)
const build = require('ata-validator/build')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'fixtures', 'compile-away-resolver')
const entry = path.join(root, 'entry.mjs')
const options = { schemas: 'none/*.json', compileAway: true }
const RUNTIME_MARKER = 'items ## '

const STAND_IN = `import { Validator } from 'ata-validator'
const fields = (e) => ({ keyword: e.keyword, instancePath: e.instancePath, schemaPath: e.schemaPath, params: e.params, message: e.message })
const answer = (r, values, raw) => r.valid ? { values: raw ? Object.assign({}, values) : values, errors: {} } : { values: {}, errors: r.errors.map(fields) }
export const ataResolver = (schema, schemaOptions, resolverOptions = {}) => {
  const v = new Validator(schema, schemaOptions)
  return async (values) => answer(v.validate(values), values, resolverOptions.raw)
}
export const ataCompiledResolver = (compiled, resolverOptions = {}) => async (values) => {
  if (compiled.applyDefaults) compiled.applyDefaults(values)
  return answer(compiled.validate(values), values, resolverOptions.raw)
}
`

async function writeResolvers(dir, withCompiled) {
  const pkg = path.join(dir, 'node_modules', '@hookform', 'resolvers')
  await fs.mkdir(path.join(pkg, 'ata-validator'), { recursive: true })
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@hookform/resolvers', version: '0.0.0-test', type: 'module', exports: { './ata-validator': { import: './ata-validator/index.mjs', require: './ata-validator/index.cjs' } } }))
  const src = withCompiled ? STAND_IN : STAND_IN.slice(0, STAND_IN.indexOf('export const ataCompiledResolver'))
  await fs.writeFile(path.join(pkg, 'ata-validator', 'index.mjs'), src)
  await fs.writeFile(path.join(pkg, 'ata-validator', 'index.cjs'), withCompiled ? '// ataCompiledResolver\n' : '// runtime only\n')
}

const DOCS = [
  { name: 'Ayse', email: 'ayse@example.com', home: { street: 'Bagdat', zip: '34710' } },
  { name: 'Ayse', email: 'ayse@example.com', home: { street: 'Bagdat', zip: '34710' }, work: { street: 'Levent', zip: '34330', country: 'DE' }, newsletter: true },
  { name: 'A', email: 'Nope', home: { street: 'ab', zip: '12a' }, work: { zip: '1' } },
  { email: 'x@y.z', home: {}, extra: 1 },
  { name: 'Ayse', email: 'a@b.co', home: { street: 'Bagdat', zip: 'abcde', country: 'FR' } },
  {},
  null,
]

async function check(file) {
  const src = await fs.readFile(file, 'utf8')
  assert.ok(!src.includes(RUNTIME_MARKER), 'the build still carries the runtime compiler or interpreter')
  assert.ok(src.includes('__ataCompiled2'), 'not every call was replaced')
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`)
  const { ataResolver } = await import(pathToFileURL(path.join(root, 'node_modules', '@hookform', 'resolvers', 'ata-validator', 'index.mjs')).href)
  for (const [name, runtime] of [['resolve', ataResolver(mod.Signup)], ['resolveRaw', ataResolver(mod.Signup, undefined, { raw: true })], ['resolveEmptyOptions', ataResolver(mod.Signup, {})]]) {
    for (const d of DOCS) {
      const a = await mod[name](structuredClone(d)), b = await runtime(structuredClone(d))
      assert.equal(JSON.stringify(a), JSON.stringify(b), `${name} ${JSON.stringify(d)}`)
    }
  }
}

before(async () => { await writeResolvers(root, true) })

describe('ataResolver compiled away in every bundler', () => {
  it('esbuild', async () => {
    const esbuild = await import('esbuild')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-resolver-esbuild-'))
    await esbuild.build({ entryPoints: [entry], absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'out.mjs'), plugins: [unplugin.esbuild(options)], logLevel: 'silent' })
    await check(path.join(dir, 'out.mjs'))
  })

  it('rollup', async () => {
    const { rollup } = await import('rollup')
    const dir = await fs.mkdtemp(path.join(root, '.out-rollup-'))
    const bundle = await rollup({ input: entry, plugins: [unplugin.rollup({ ...options, root })], external: [/^node:/, /^@hookform\//] })
    await bundle.write({ file: path.join(dir, 'out.mjs'), format: 'es' })
    await bundle.close()
    try { await check(path.join(dir, 'out.mjs')) } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('vite', async () => {
    const { build: viteBuild } = await import('vite')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-resolver-vite-'))
    await viteBuild({ configFile: false, root, logLevel: 'silent', plugins: [unplugin.vite(options)], build: { lib: { entry, formats: ['es'], fileName: () => 'out.mjs' }, outDir: dir, emptyOutDir: true, minify: false } })
    await check(path.join(dir, 'out.mjs'))
  })
})

describe('what stays on the runtime', () => {
  const ata = { ...build, compiledResolver: () => true }
  const rewrite = (file, api = ata) => compileAway(require('node:fs').readFileSync(path.join(root, file), 'utf8'), path.join(root, file), api, {})

  it('validator options and a schema the build cannot read', () => {
    assert.equal(rewrite('runtime-kept.mjs'), null)
  })

  it('a resolvers package without ataCompiledResolver', () => {
    assert.equal(rewrite('entry.mjs', { ...build, compiledResolver: () => false }), null)
  })

  it('a resolvers package whose import file lacks ataCompiledResolver, though its require file has it', async () => {
    // A bundler takes the `import` file; probing only the `require` one built an import that did not exist.
    const { __internal } = await import('../src/core.js')
    const ataApi = await __internal.loadAta()
    for (const [mjs, cjs, expected] of [
      ['// runtime only\n', '// ataCompiledResolver\n', false],
      ['// ataCompiledResolver\n', '// runtime only\n', false],
      ['// ataCompiledResolver\n', '// ataCompiledResolver\n', true],
    ]) {
      const dir = await fs.mkdtemp(path.join(here, 'fixtures', 'tmp-probe-'))
      try {
        await writeResolvers(dir, true)
        const pkg = path.join(dir, 'node_modules', '@hookform', 'resolvers', 'ata-validator')
        await fs.writeFile(path.join(pkg, 'index.mjs'), mjs)
        await fs.writeFile(path.join(pkg, 'index.cjs'), cjs)
        assert.equal(ataApi.compiledResolver(path.join(dir, 'app.mjs')), expected)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  })

  it('an ata-validator without the runtime error order', () => {
    const old = { ...ata, compiledModuleFor: (s, o) => build.compiledModuleFor(s, { ...o, order: false }) }
    assert.equal(rewrite('entry.mjs', old), null)
  })

  it('the replaced calls take the compiled resolver and the runtime import goes', () => {
    const out = rewrite('entry.mjs')
    assert.match(out.code, /import \{ ataCompiledResolver as __ataCompiledResolver \} from '@hookform\/resolvers\/ata-validator'/)
    assert.doesNotMatch(out.code, /\bataResolver\b/)
    assert.match(out.code, /__ataCompiledResolver\(__ataCompiled1, \{"raw":true\}\)/)
    assert.match(out.code, /return \{ validate, applyDefaults \}/)
  })
})
