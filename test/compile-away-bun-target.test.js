// The Bun target inside the plugin: under `Bun.build({ compile: { aot: true } })`
// a module compiled from the `schemas` globs gets a `.bun.ts` beside it (the
// schema as a type, the module's functions with the type on them, a typed
// parse), an import of the module goes there, and every module takes the form
// written for Bun's compiler. A replaced `new Validator(schema)` in source
// keeps the plain module in every file. Checked here: the transform's output
// and the written target, on Node; and, when a Bun with --aot is at hand
// (BUN_AOT=/path/to/bun), the executable it builds answers as the runtime does.

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
  it('keeps the plain module for a replaced call, with or without the target', () => {
    const code = `import { Validator } from 'ata-validator'
const check = new Validator(${ORDER})
export const ok = (d: unknown) => check.isValidObject(d)
export const why = (d: unknown) => check.validate(d).errors
`
    const out = compileAway(code, '/app/src/orders.ts', ata, { bunTarget: ata.bunTarget })
    assert.ok(out && out.code)
    assert.ok(!out.code.includes('bun:bundle') && !/from 'bun'/.test(out.code), 'nothing imported from Bun')
    // It reads errors but never validates JSON text: the wrapper without those entry points.
    // (ata-validator 1.61.1 on; an older one has only the full wrapper.)
    assert.ok(out.code.includes(ata.compiledObject ? '__ataFromCompiledObject(__ataCompiled0,' : '__ataFromCompiled(__ataCompiled0,'), out.code.slice(0, 400))
    assert.ok(!out.code.includes('new Validator('))
    const off = compileAway(code, '/app/src/orders.ts', ata, {})
    assert.equal(off.code, out.code, 'the option changes nothing in a source file')
  })

  it('writes the type and a typed parse beside a glob-compiled module, through the module', () => {
    const mapped = ata.bunTarget.schemaToBunType(JSON.parse(ORDER.replace(/(\w+):/g, '"$1":').replace(/'/g, '"')), { name: 'Order' })
    assert.equal(mapped.residual, null)
    assert.equal(mapped.type, '{ "id": number; "email": string; "tags": string[] }')
    const src = ata.bunTarget.toBunModule({ schemaFile: 'order.schema.json', moduleImport: './order.schema.js', typeName: mapped.name, typeSource: mapped.type, aliases: mapped.aliases })
    assert.ok(src.includes('import * as _m from "./order.schema.js"'))
    assert.ok(src.includes('export function isValid (d: unknown): d is Order { return _m.isValid(d) }'))
    assert.ok(src.includes('const d: Order = JSON.parse(text)'))
    assert.ok(!src.includes('bun:bundle'))
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
  it('builds an executable with Bun whose answers are the runtime\'s', { skip: bun ? false : 'set BUN_AOT to a Bun with --aot' }, async () => {
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
    assert.deepEqual(files, ['user.schema.bun.ts', 'user.schema.d.ts', 'user.schema.js', 'user.schema.json'])
    const bunSrc = await fs.readFile(path.join(dir, 'schemas', 'user.schema.bun.ts'), 'utf8')
    assert.ok(bunSrc.includes('export default validate'), 'the same default as the module')
    assert.ok(bunSrc.includes('export type User = '))
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
