// The Bun target inside the plugin: under `Bun.build({ compile: { aot: true } })`
// a replaced `new Validator(schema)` in a TypeScript file hands the schema's
// rules to Bun's compiler as a type (validate<T>), with the residual module
// and the plain module behind it, so every answer stays the plain module's.
// Checked here: the transform's output, on Node; and, when a Bun with --aot
// is at hand (BUN_AOT=/path/to/bun), the executable it builds answers as the
// runtime does and takes the typed path.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const ata = await __internal.loadAta()
const can = !!(ata && ata.compiledModuleFor && ata.bunTarget)
const here = path.dirname(fileURLToPath(import.meta.url))

const ORDER = `{ type: 'object', required: ['id', 'email', 'tags'], additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 }, email: { type: 'string', format: 'email' }, tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 4 } } }`

describe('bun target in compile-away', { skip: can ? false : 'ata-validator with bunTarget is not installed' }, () => {
  it('writes the type, the residual module and a fast isValid for a TypeScript file', () => {
    const code = `import { Validator } from 'ata-validator'
const check = new Validator(${ORDER})
export const ok = (d: unknown) => check.isValidObject(d)
export const why = (d: unknown) => check.validate(d).errors
`
    const out = compileAway(code, '/app/src/orders.ts', ata, { bunTarget: ata.bunTarget })
    assert.ok(out && out.code)
    const c = out.code
    assert.ok(c.includes("import { validate as __ataCheck } from 'bun:bundle';"), c.slice(0, 300))
    assert.ok(c.includes("import type { Schema } from 'bun';"))
    assert.match(c, /type __AtaT0 = \{ "id": number & Schema\.Int & Schema\.Min<1>; "email": string; "tags": \(string & Schema\.MinLength<1>\)\[\] & Schema\.MaxItems<4> \} & Schema\.Strict;/)
    // format: email is the residual, compiled beside the type.
    assert.ok(c.includes('const __ataRest0 = (() => {'), 'residual module inlined')
    assert.ok(c.includes('__ataCheck<__AtaT0>(d)'))
    assert.ok(c.includes('return __ataRest0.isValid(d)'))
    assert.ok(c.includes('catch { return __ataCompiled0.isValid(d) }'))
    assert.ok(c.includes('__ataFromCompiled(__ataFast0,'))
    assert.ok(!c.includes('new Validator('))
    // With `virtual`, the modules leave the file as imports of .js modules.
    const got = new Map()
    const v = compileAway(code, '/app/src/orders.ts', ata, { bunTarget: ata.bunTarget, virtual: (src) => { const id = `ata-compiled:${got.size}.js`; got.set(id, src); return id } })
    assert.equal(got.size, 2, 'the module and the residual')
    assert.ok(v.code.includes('import * as __ataCompiled0 from "ata-compiled:0.js"'), v.code.slice(0, 400))
    assert.ok(v.code.includes('import * as __ataRest0 from "ata-compiled:1.js"'))
    assert.ok(!v.code.includes('const __ataCompiled0 = (() =>'))
    assert.ok(/export \{[^}]*isValid/.test(got.get('ata-compiled:0.js')), 'the virtual module keeps its exports')
  })

  it('keeps the plain module for a JavaScript file and when the target is off', () => {
    const code = `import { Validator } from 'ata-validator'
const check = new Validator({ type: 'string', minLength: 2 })
export const ok = (d) => check.isValidObject(d)
`
    const js = compileAway(code, '/app/src/orders.js', ata, { bunTarget: ata.bunTarget })
    assert.ok(js && js.code && !js.code.includes('bun:bundle') && js.code.includes('__ataFromCompiledVerdict(__ataCompiled0,'))
    const off = compileAway(code, '/app/src/orders.ts', ata, {})
    assert.ok(off && off.code && !off.code.includes('bun:bundle'))
  })

  it('records the schemas for verify, with the self-contained module', () => {
    const verifying = new Map()
    const code = `import { Validator } from 'ata-validator'
const a = new Validator({ type: 'integer' })
export const ok = (d: unknown) => a.isValidObject(d)
`
    compileAway(code, '/app/src/n.ts', ata, { verifying })
    assert.equal(verifying.size, 1)
    const [[key, entry]] = verifying
    assert.equal(key, '/app/src/n.ts:2')
    assert.deepEqual(entry.schema, { type: 'integer' })
    assert.match(entry.src, /export \{/)
  })

  const bun = process.env.BUN_AOT
  it('builds an executable with Bun whose answers are the runtime\'s and whose check is typed', { skip: bun ? false : 'set BUN_AOT to a Bun with --aot' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-bun-aot-'))
    const plugin = path.resolve(here, '..', 'src', 'bun.js')
    await fs.writeFile(path.join(dir, 'orders.ts'), `import { Validator } from 'ata-validator'
const check = new Validator(${ORDER})
const docs: unknown[] = [{ id: 1, email: 'a@b.co', tags: ['x'] }, { id: 0, email: 'a@b.co', tags: [] }, { id: 2, email: 'nope', tags: ['x'] }, { id: 2, email: 'a@b.co', tags: ['x'], extra: 1 }, 'no']
console.log(JSON.stringify(docs.map((d) => check.isValidObject(d))))
console.log(JSON.stringify(docs.map((d) => check.validate(d).errors.map((e: any) => e.keyword))))
`)
    await fs.writeFile(path.join(dir, 'build.ts'), `import ata from ${JSON.stringify(plugin)}
const r = await Bun.build({ entrypoints: ['./orders.ts'], compile: { outfile: './orders', aot: true }, plugins: [ata({ schemas: 'none/**/*.json', root: ${JSON.stringify(dir)} })], root: ${JSON.stringify(dir)} })
if (!r.success) { console.error(r.logs.map((l) => l.message).join('\\n')); process.exit(1) }
`)
    // The plugin resolves ata-validator from its own node_modules; the temp
    // dir gets a link so the entry's import resolves there too.
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await fs.symlink(path.resolve(here, '..', 'node_modules', 'ata-validator'), path.join(dir, 'node_modules', 'ata-validator'))
    // A project with @types/bun type-checks strictly under --aot; plain
    // JavaScript written into a TypeScript file would fail with TS7006.
    await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: true } }))
    const b = spawnSync(bun, ['build.ts'], { cwd: dir, encoding: 'utf8' })
    assert.equal(b.status, 0, b.stdout + b.stderr)
    const r = spawnSync(path.join(dir, 'orders'), [], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const [verdicts, errors] = r.stdout.trim().split('\n')
    assert.equal(verdicts, '[true,false,false,false,false]')
    assert.equal(errors, '[[],["minimum"],["format"],["additionalProperties"],["type"]]')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes the Bun target beside a glob-compiled schema and sends its import there', { skip: bun ? false : 'set BUN_AOT to a Bun with --aot' }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-bun-glob-'))
    const plugin = path.resolve(here, '..', 'src', 'bun.js')
    await fs.mkdir(path.join(dir, 'schemas'))
    await fs.writeFile(path.join(dir, 'schemas', 'user.schema.json'), JSON.stringify({ type: 'object', required: ['id', 'mail'], additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 }, mail: { type: 'string', format: 'email' } } }))
    await fs.writeFile(path.join(dir, 'main.ts'), `import validate, { isValid, parse } from './schemas/user.schema'
const docs: unknown[] = [{ id: 1, mail: 'a@b.co' }, { id: 0, mail: 'a@b.co' }, { id: 2, mail: 'nope' }, { id: 2, mail: 'a@b.co', x: 1 }]
console.log(JSON.stringify(docs.map((d) => isValid(d))))
console.log(JSON.stringify(docs.map((d) => validate(d).errors.map((e: any) => e.keyword))))
console.log(JSON.stringify([parse('{"id":3,"mail":"c@d.ee"}'), parse('{"id":"3"}'), parse('nope')]))
`)
    await fs.writeFile(path.join(dir, 'build.ts'), `import ata from ${JSON.stringify(plugin)}
const r = await Bun.build({ entrypoints: ['./main.ts'], compile: { outfile: './main', aot: true }, plugins: [ata({ schemas: 'schemas/**/*.schema.json', root: ${JSON.stringify(dir)} })], root: ${JSON.stringify(dir)} })
if (!r.success) { console.error(r.logs.map((l) => l.message).join('\\n')); process.exit(1) }
`)
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await fs.symlink(path.resolve(here, '..', 'node_modules', 'ata-validator'), path.join(dir, 'node_modules', 'ata-validator'))
    await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noImplicitAny: true } }))
    const b = spawnSync(bun, ['build.ts'], { cwd: dir, encoding: 'utf8' })
    assert.equal(b.status, 0, b.stdout + b.stderr)
    const files = (await fs.readdir(path.join(dir, 'schemas'))).sort()
    assert.deepEqual(files, ['user.schema.bun.ts', 'user.schema.d.ts', 'user.schema.js', 'user.schema.json', 'user.schema.rest.js'])
    const bunSrc = await fs.readFile(path.join(dir, 'schemas', 'user.schema.bun.ts'), 'utf8')
    assert.ok(bunSrc.includes('export default validate'), 'the same default as the module')
    assert.ok(bunSrc.includes('"./user.schema.rest.js"'), 'the residual (format: email) beside it')
    const r = spawnSync(path.join(dir, 'main'), [], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const [verdicts, errors, parsed] = r.stdout.trim().split('\n')
    assert.equal(verdicts, '[true,false,false,false]')
    assert.equal(errors, '[[],["minimum"],["format"],["additionalProperties"]]')
    // parse() exists only on the Bun target, so its presence shows the import went there.
    assert.equal(parsed, '[{"id":3,"mail":"c@d.ee"},null,null]')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
