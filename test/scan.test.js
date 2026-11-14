// The scan (src/scan.js, `unplugin-ata scan`): what a build would do with a
// project, read without building it, and for every zodResolver call it would
// leave as written, a reason that names the schema, the field and the cause.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { scanProject, render } from '../src/scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const HEAD = "import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\n"

describe('scan', () => {
  let dir
  before(async () => {
    dir = await fs.mkdtemp(path.join(here, 'fixtures', 'scan-'))
    await fs.mkdir(path.join(dir, 'app'))
    await fs.mkdir(path.join(dir, 'lib'))
    await fs.writeFile(path.join(dir, 'lib', 'schemas.ts'), "import { z } from 'zod'\nexport const loginSchema = z.object({ email: z.email('Enter a valid email'), password: z.string().min(6) })\n")
    await fs.writeFile(path.join(dir, 'app', 'good.js'), `${HEAD}const formSchema = z.object({ name: z.string().trim().min(2, 'Too short'), role: z.enum(['a', 'b']) })\nexport const r = zodResolver(formSchema)\n`)
    await fs.writeFile(path.join(dir, 'app', 'mixed.ts'), `${HEAD}import { loginSchema } from '../lib/schemas'
const limit = Number(process.env.LIMIT || 8)
const passwords = z.object({ password: z.string().min(8), confirm: z.string() }).refine((v) => v.password.length >= limit)
const tags = z.object({ profile: z.object({ tags: z.array(z.union([z.string(), z.number()])).min(1) }) })
const site = z.object({ site: z.string().url().max(200) })
export const make = (min: number) => { const schema = z.object({ name: z.string().min(min) }); return zodResolver(schema) }
export const a = zodResolver(passwords)
export const b = zodResolver(tags)
export const c = zodResolver(site)
export const d = zodResolver(loginSchema)
export const e = zodResolver(loginSchema, undefined, { raw: true })
`)
  })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

  it('counts what would be compiled and says why the rest would not', async () => {
    const r = await scanProject(dir)
    assert.equal(r.zod.compiled, 1, 'good.js; mixed.ts keeps loginSchema because one of its two calls passes options')
    const reasons = Object.fromEntries(r.zod.kept.map((k) => [/zodResolver\(([^)]*)\)/.exec(k.reason)[1] + '@' + k.line, k.reason]))
    assert.equal(r.zod.kept.length, 6)
    for (const k of r.zod.kept) assert.equal(k.file, path.join('app', 'mixed.ts'))
    assert.match(reasons['schema@8'], /the schema uses `min`, which is not zod or a constant of the file/)
    assert.match(reasons['passwords@9'], /a refine reads `limit` from outside its own argument/)
    assert.match(reasons['tags@10'], /profile\.tags\.\*: a union is not carried yet/)
    assert.match(reasons['site@11'], /site: a check written after url\(\) is not carried/)
    assert.match(reasons['loginSchema@13'], /passes options/)
    assert.match(reasons['loginSchema@12'], /also used as a value elsewhere/)
    assert.deepEqual(r.failed, [])
    const text = render(r)
    assert.match(text, /^zodResolver: 1 of 7 calls would be compiled/)
    assert.match(text, /Nothing was written\.$/)
  })
  it('writes nothing', async () => {
    const before = (await fs.readdir(dir, { recursive: true })).sort()
    await scanProject(dir)
    assert.deepEqual((await fs.readdir(dir, { recursive: true })).sort(), before)
  })
  it('runs as a command, with --json', () => {
    const cli = path.join(here, '..', 'src', 'cli.js')
    const out = JSON.parse(execFileSync(process.execPath, [cli, 'scan', dir, '--json'], { encoding: 'utf8' }))
    assert.equal(out.zod.compiled, 1)
    assert.equal(out.zod.kept.length, 6)
    assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /Usage: unplugin-ata scan/)
  })
})
