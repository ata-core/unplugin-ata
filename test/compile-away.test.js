// compileAway: every bundler builds an entry that uses `new Validator(schema)`
// the ordinary way, and the built output must (1) carry neither the runtime
// compiler nor the interpreter, and (2) answer exactly as `new Validator` does,
// errors included, compared as JSON. The transform's decline rules are tested
// directly further down, since a wrong replacement there would be silent.

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

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'fixtures', 'compile-away')
const entry = path.join(root, 'entry.mjs')
const options = { schemas: 'none/*.json', compileAway: true }

// A string only the runtime compiler and the interpreter contain: the
// uniqueItems message. The fixture schema does not use uniqueItems, so a build
// that carries it carries the runtime.
const RUNTIME_MARKER = 'items ## '

const DOCS = [
  { id: 1, name: 'a' },
  { id: 1, name: 'a', email: 'a@b.co', tags: ['x'] },
  { id: 0, name: '' },
  { id: 1.5, name: 'x'.repeat(65), email: 'nope', tags: [1, 'b'] },
  { name: 'a', extra: true },
  null,
  'str',
  [],
]

async function outDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `unplugin-ata-away-${name}-`))
}

async function check(file) {
  const src = await fs.readFile(file, 'utf8')
  assert.ok(!src.includes(RUNTIME_MARKER), 'the build still carries the runtime compiler or interpreter')
  assert.ok(src.includes('__ataCompiled0'), 'nothing was replaced')
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`)
  const runtime = new Validator(mod.Body)
  for (const d of DOCS) {
    const text = JSON.stringify(d)
    assert.equal(JSON.stringify(mod.validate(structuredClone(d))), JSON.stringify(runtime.validate(structuredClone(d))), `validate ${text}`)
    assert.equal(mod.isValidObject(structuredClone(d)), runtime.isValidObject(structuredClone(d)), `isValidObject ${text}`)
    assert.equal(JSON.stringify(mod.validateJSON(text)), JSON.stringify(runtime.validateJSON(text)), `validateJSON ${text}`)
    assert.equal(mod.isValidJSON(text), runtime.isValidJSON(text), `isValidJSON ${text}`)
  }
  assert.equal(JSON.stringify(mod.validateJSON('{"id": 1,')), JSON.stringify(runtime.validateJSON('{"id": 1,')), 'malformed JSON')
  const data = { id: 2, name: 'b' }
  assert.equal(mod.validate(data).data, data, 'a valid result carries the input as data')
  // Defaults are filled in before the check, as the runtime fills them.
  const settingsRuntime = new Validator(mod.Settings)
  assert.ok(src.includes('__ataCompiled2'), 'the schema with defaults was compiled away too')
  const asIsRuntime = new Validator(mod.Settings, { useDefaults: false })
  assert.ok(src.includes('__ataCompiled3'), 'the call with { useDefaults: false } was compiled away too')
  for (const d of [{}, { theme: 'dark' }, { notify: {} }, { notify: { every: 0 } }, { theme: 'blue' }, { notify: 'x' }]) {
    assert.equal(JSON.stringify(mod.validateSettings(structuredClone(d))), JSON.stringify(settingsRuntime.validate(structuredClone(d))), `settings ${JSON.stringify(d)}`)
    const a = structuredClone(d), b = structuredClone(d)
    assert.equal(JSON.stringify(mod.validateSettingsAsIs(a)), JSON.stringify(asIsRuntime.validate(b)), `settings, useDefaults: false, ${JSON.stringify(d)}`)
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'useDefaults: false leaves the input as the runtime does')
  }
  assert.equal(mod.nameOk('ab'), true)
  assert.equal(mod.nameOk('a'), false)
}

describe('compileAway in every bundler', () => {
  it('rollup', async () => {
    const { rollup } = await import('rollup')
    // Rollup leaves the bare import of ata-validator/compiled to the runtime
    // without a resolve plugin, so its output goes where Node can find it.
    const dir = await fs.mkdtemp(path.join(here, '.out-rollup-'))
    const bundle = await rollup({ input: entry, plugins: [unplugin.rollup({ ...options, root })], external: [/^node:/] })
    await bundle.write({ file: path.join(dir, 'out.mjs'), format: 'es' })
    await bundle.close()
    try {
      const out = await fs.readFile(path.join(dir, 'out.mjs'), 'utf8')
      // `shortName` only asks for a boolean, so it takes the verdict wrapper.
      assert.deepEqual([...out.matchAll(/from ['"](ata-validator[^'"]*)['"]/g)].map((m) => m[1]).sort(), ['ata-validator/compiled', 'ata-validator/compiled-verdict'])
      await check(path.join(dir, 'out.mjs'))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('rolldown', async () => {
    const { rolldown } = await import('rolldown')
    const dir = await outDir('rolldown')
    const bundle = await rolldown({ input: entry, plugins: [unplugin.rolldown({ ...options, root })], platform: 'node' })
    await bundle.write({ file: path.join(dir, 'out.mjs'), format: 'es' })
    await bundle.close()
    await check(path.join(dir, 'out.mjs'))
  })

  it('vite', async () => {
    const { build } = await import('vite')
    const dir = await outDir('vite')
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [unplugin.vite(options)],
      build: { lib: { entry, formats: ['es'], fileName: () => 'out.mjs' }, outDir: dir, emptyOutDir: true, minify: false },
    })
    await check(path.join(dir, 'out.mjs'))
  })

  it('esbuild', async () => {
    const esbuild = await import('esbuild')
    const dir = await outDir('esbuild')
    await esbuild.build({ entryPoints: [entry], absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'out.mjs'), plugins: [unplugin.esbuild(options)], logLevel: 'silent' })
    await check(path.join(dir, 'out.mjs'))
  })

  for (const name of ['webpack', 'rspack']) {
    it(name, async () => {
      const run = name === 'webpack' ? (await import('webpack')).default : (await import('@rspack/core')).rspack
      const dir = await outDir(name)
      await new Promise((resolve, reject) => {
        run({
          mode: 'production',
          context: root,
          entry,
          target: 'node',
          experiments: { outputModule: true },
          output: { path: dir, filename: 'out.mjs', library: { type: 'module' } },
          optimization: { minimize: false },
          plugins: [unplugin[name](options)],
        }, (err, stats) => {
          if (err) return reject(err)
          if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true, all: false })))
          resolve()
        })
      })
      await check(path.join(dir, 'out.mjs'))
    })
  }
})

describe('compileAway is on by default', () => {
  const build = async (name, opts) => {
    const esbuild = await import('esbuild')
    const dir = await outDir(name)
    const out = path.join(dir, 'out.mjs')
    await esbuild.build({ entryPoints: [entry], absWorkingDir: root, bundle: true, format: 'esm', platform: 'node', outfile: out, plugins: [unplugin.esbuild(opts)], logLevel: 'silent' })
    return out
  }

  it('replaces calls when the option is not given', async () => {
    await check(await build('default', { schemas: 'none/*.json' }))
  })

  it('leaves the runtime in place with compileAway: false', async () => {
    const src = await fs.readFile(await build('off', { schemas: 'none/*.json', compileAway: false }), 'utf8')
    assert.ok(src.includes(RUNTIME_MARKER), 'turning it off keeps the runtime')
    assert.ok(!src.includes('__ataCompiled0'), 'turning it off replaces nothing')
  })
})

describe('compileAway picks the smaller wrapper when errors are never read', () => {
  const head = "import { Validator } from 'ata-validator'\n"
  const file = path.join(root, 'v.ts')
  const withVerdict = { ...ata, compiledVerdict: true }

  it('uses the verdict wrapper for isValidObject and isValidJSON only', () => {
    const out = compileAway(head + "const v = new Validator({ type: 'integer' })\nexport const f = (x) => v.isValidObject(x) && v.isValidJSON('1')\n", file, withVerdict)
    assert.ok(out.code.includes("from 'ata-validator/compiled-verdict'"))
    assert.ok(!out.code.includes("from 'ata-validator/compiled'"))
    assert.ok(out.code.includes('return { isValid };'), 'the error function is not handed out')
  })

  it('keeps the full wrapper once any call reads errors', () => {
    const out = compileAway(head + "const v = new Validator({ type: 'integer' })\nexport const f = (x) => v.isValidObject(x) && v.validate(x)\n", file, withVerdict)
    assert.ok(out.code.includes("from 'ata-validator/compiled'"))
    assert.ok(!out.code.includes('compiled-verdict'))
  })

  it('imports each wrapper once when a file needs both', () => {
    const out = compileAway(head + "const a = new Validator({ type: 'integer' })\nconst b = new Validator({ type: 'string' })\nexport const f = (x) => a.isValidObject(x) && b.validate(x)\n", file, withVerdict)
    assert.equal(out.code.split("from 'ata-validator/compiled-verdict'").length - 1, 1)
    assert.equal(out.code.split("from 'ata-validator/compiled'").length - 1, 1)
  })

  it('stays on the full wrapper with an ata-validator that has no verdict entry', () => {
    const out = compileAway(head + "const v = new Validator({ type: 'integer' })\nexport const f = (x) => v.isValidObject(x)\n", file, { ...ata, compiledVerdict: false })
    assert.ok(out.code.includes("from 'ata-validator/compiled'"))
    assert.ok(!out.code.includes('compiled-verdict'))
  })
})

describe('compileAway decides conservatively', () => {
  const run = (code, file = path.join(root, 'x.ts')) => compileAway(code, file, ata)
  const head = "import { Validator, defineSchema } from 'ata-validator'\n"

  it('replaces a literal, a const, a .json import and defineSchema, in TypeScript', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-json-'))
    await fs.writeFile(path.join(dir, 'user.schema.json'), JSON.stringify({ type: 'object', properties: { n: { type: 'integer' } } }))
    const out = compileAway(head + "import user from './user.schema.json'\nconst S = { type: 'string' } as const satisfies object\nconst a = new Validator({ type: 'integer' })\nconst b = new Validator(S)\nconst c = new Validator(user)\nconst d = new Validator(defineSchema({ type: 'boolean' }))\nexport const f = (x: unknown) => a.isValidObject(x) && b.validate(x).valid && c.isValidJSON('1') && d.validateJSON('true').valid\n", path.join(dir, 'app.ts'), ata)
    assert.equal(out.replaced, 4)
    assert.doesNotMatch(out.code, /from 'ata-validator'/, 'the runtime import goes once nothing uses it')
    const kept = compileAway(head + "const a = new Validator({ type: 'integer' })\nconst S = defineSchema({ type: 'string' })\nexport const f = (x) => a.isValidObject(x) && S\n", path.join(root, 'k.ts'), ata)
    assert.match(kept.code, /import \{ defineSchema \} from 'ata-validator'/, 'a specifier still in use stays')
  })

  it('leaves a call alone when the schema cannot be read statically', () => {
    assert.equal(run(head + 'const s = load()\nconst v = new Validator(s)\nv.validate(1)\n'), null)
    assert.equal(run(head + "const v = new Validator({ type: 'object', properties: { [k]: {} } })\nv.validate(1)\n"), null)
    assert.equal(run(head + "const base = { type: 'object' }\nconst v = new Validator({ ...base })\nv.validate(1)\n"), null)
    assert.equal(run(head + "let s = { type: 'string' }\nconst v = new Validator(s)\nv.validate(1)\n"), null)
  })

  it('leaves a call alone when the instance is used beyond the four methods', () => {
    const s = "{ type: 'string' }"
    assert.equal(run(head + `const v = new Validator(${s})\nv.parse('a')\n`), null)
    assert.equal(run(head + `const v = new Validator(${s})\nuse(v)\n`), null)
    assert.equal(run(head + `export const v = new Validator(${s})\n`), null)
    assert.equal(run(head + `const v = new Validator(${s})\nexport { v }\n`), null)
    assert.equal(run(head + `const v = new Validator(${s})\nconst m = v.validate\n`), null)
    assert.equal(run(head + `const v = new Validator(${s})\nv['validate'](1)\n`), null)
    assert.equal(run(head + `let v = new Validator(${s})\nv.validate(1)\n`), null)
    assert.equal(run(head + `const v = new Validator(${s}, { coerceTypes: true })\nv.validate(1)\n`), null)
    assert.equal(run(head + `const v = new Validator(${s}, { useDefaults: false, coerceTypes: true })\nv.validate(1)\n`), null)
    assert.equal(run(head + `const v = new Validator(${s}, { useDefaults: flag })\nv.validate(1)\n`), null)
    assert.equal(run(head + `const o = load()\nconst v = new Validator(${s}, o)\nv.validate(1)\n`), null)
    assert.equal(run(head + `function f () { const v = new Validator(${s}); return v }\n`), null)
  })

  it('replaces a call with { useDefaults: false } only when ata-validator reproduces it', () => {
    const s = "{ type: 'object', properties: { n: { type: 'integer', default: 1 } } }"
    const code = head + `const o = { useDefaults: false }\nconst v = new Validator(${s}, o)\nexport const f = (x) => v.validate(x)\n`
    const out = run(code)
    assert.ok(out && out.replaced === 1, 'replaced')
    assert.match(out.code, /__ataFromCompiled\(__ataCompiled0, .*, \{"useDefaults":false\}\)/)
    const old = compileAway(code, path.join(root, 'x.ts'), { ...ata, compiledOptions: undefined })
    assert.equal(old, null, 'an ata-validator without compiledOptions keeps calls with options on the runtime')
    const dflt = run(head + `const v = new Validator(${s}, { useDefaults: true })\nexport const f = (x) => v.validate(x)\n`)
    assert.ok(dflt && !/useDefaults/.test(dflt.code.split('__ataFromCompiled(')[1] || ''), 'useDefaults: true needs no argument')
  })

  it('leaves a call alone when ata declines the schema', () => {
    assert.equal(run(head + "const v = new Validator({ type: 'string', errorMessage: 'no' })\nv.validate(1)\n"), null)
  })

  it('does not touch a file with another Validator', () => {
    assert.equal(run("import { Validator } from 'other'\nconst v = new Validator({ type: 'string' })\nv.validate(1)\n"), null)
    assert.equal(run("class Validator {}\nconst v = new Validator({ type: 'string' })\nv.validate(1)\n"), null)
  })

  it('is on unless turned off, and never touches node_modules', () => {
    const on = unplugin.vite({ schemas: 'none/*.json' })
    assert.equal(on.transformInclude('/x/app.ts'), true)
    assert.equal(on.transformInclude('/x/node_modules/lib/app.js'), false)
    const off = unplugin.vite({ schemas: 'none/*.json', compileAway: false })
    assert.equal(off.transformInclude('/x/app.ts'), false)
  })
})

// A schema large enough that its module alone saves more than the shared error
// runtime costs: the shape of a published configuration schema, every property
// described.
function largeSchema(n = 600) {
  const props = {}
  for (let i = 0; i < n; i++) {
    props['field' + i] = {
      description: `Field ${i}, described at the length published schemas describe their fields, so the descriptions are most of the text.`,
      ...(i % 3 === 0 ? { type: 'string', maxLength: 40, pattern: '^[a-z]+$' } : i % 3 === 1 ? { type: 'integer', minimum: 0 } : { type: 'object', properties: { x: { type: 'number' }, y: { enum: ['a', 'b'] } }, required: ['x'], additionalProperties: false }),
    }
  }
  return { type: 'object', properties: props, required: ['field0', 'field1'], additionalProperties: false }
}

// The runtime entry ships with ata-validator 1.50.0; an older install skips these.
let hasErrorRuntime = true
try { require.resolve('ata-validator/error-runtime') } catch { hasErrorRuntime = false }

describe('compileAway shares one error runtime when a module pays for it', { skip: !hasErrorRuntime && 'ata-validator has no error-runtime entry' }, () => {
  const head = "import { Validator } from 'ata-validator'\n"
  const runWith = (code, sharedErrors) => compileAway(code, path.join(root, 'x.ts'), { ...ata, compiledSharedErrors: true, compiledVerdict: true }, { sharedErrors })

  it('writes a large schema compact, a small one self-contained', () => {
    const big = runWith(head + `const v = new Validator(${JSON.stringify(largeSchema())})\nexport const f = (x) => v.validate(x)\n`)
    assert.ok(big && big.code.includes("from 'ata-validator/error-runtime'"), 'large schema: compact')
    assert.equal(big.code.split("from 'ata-validator/error-runtime'").length, 2, 'one import')
    const small = runWith(head + "const v = new Validator({ type: 'object', properties: { id: { type: 'integer' } } })\nexport const f = (x) => v.validate(x)\n")
    assert.ok(small && !small.code.includes('error-runtime'), 'small schema: self-contained')
    const medium = runWith(head + `const v = new Validator(${JSON.stringify(largeSchema(150))})\nexport const f = (x) => v.validate(x)\n`)
    assert.ok(medium && !medium.code.includes('error-runtime'), 'a schema that does not pay for the runtime alone: self-contained')
    const forced = runWith(head + "const v = new Validator({ type: 'object', properties: { id: { type: 'integer' } } })\nexport const f = (x) => v.validate(x)\n", true)
    assert.ok(forced.code.includes("from 'ata-validator/error-runtime'"), 'sharedErrors: true')
    const off = runWith(head + `const v = new Validator(${JSON.stringify(largeSchema())})\nexport const f = (x) => v.validate(x)\n`, false)
    assert.ok(!off.code.includes('error-runtime'), 'sharedErrors: false')
  })

  it('leaves code that never reads errors on the verdict wrapper', () => {
    const out = runWith(head + `const v = new Validator(${JSON.stringify(largeSchema())})\nexport const f = (x) => v.isValidObject(x)\n`, true)
    assert.ok(out && !out.code.includes('error-runtime'), 'no runtime for the verdict wrapper')
  })

  it('a compact build answers as new Validator does, and is smaller', async () => {
    const esbuild = await import('esbuild')
    const dir = await outDir('shared')
    const schema = largeSchema()
    const src = path.join(dir, 'entry.mjs')
    await fs.writeFile(src, head + `export const Body = ${JSON.stringify(schema)}\nconst v = new Validator(${JSON.stringify(schema)})\nexport const validate = (x) => v.validate(x)\n`)
    const sizes = {}
    for (const sharedErrors of ['auto', false]) {
      const out = path.join(dir, `out-${sharedErrors}.mjs`)
      await esbuild.build({ entryPoints: [src], absWorkingDir: here, nodePaths: [path.join(here, '..', 'node_modules')], bundle: true, minify: true, format: 'esm', platform: 'node', outfile: out, plugins: [unplugin.esbuild({ schemas: 'none/*.json', compileAway: true, sharedErrors })], logLevel: 'silent' })
      const text = await fs.readFile(out, 'utf8')
      sizes[sharedErrors] = (await import('node:zlib')).gzipSync(text).length
      const mod = await import(pathToFileURL(out).href)
      const runtime = new Validator(schema)
      const docs = [{ field0: 'ab', field1: 2 }, { field0: 'AB', field1: -1, field2: { y: 'c' }, extra: 1 }, {}, null, { field0: 'x'.repeat(50), field1: 1.5, field5: {} }]
      for (const d of docs) assert.equal(JSON.stringify(mod.validate(structuredClone(d))), JSON.stringify(runtime.validate(structuredClone(d))), `${sharedErrors} ${JSON.stringify(d)}`)
    }
    assert.ok(sizes.auto < sizes.false, `compact ${sizes.auto} should be below self-contained ${sizes.false}`)
  })
})
