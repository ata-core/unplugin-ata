// `verify: true`: at the end of a build every validator compiled away is held
// against the runtime on documents made from its schema, inside the bundler.
// Checked with esbuild: a build with two replaced validators passes, and the
// plugin asked for the check (the session's list is consumed).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { __internal } from '../src/core.js'
import unplugin from '../src/index.js'

const ata = await __internal.loadAta()
const can = !!(ata && ata.compiledModuleFor && ata.verify)

describe('verify option', { skip: can ? false : 'ata-validator with verify is not installed' }, () => {
  it('holds the compiled validators against the runtime at the end of an esbuild build', async () => {
    const esbuild = await import('esbuild')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unplugin-ata-verify-'))
    const entry = path.join(dir, 'entry.ts')
    await fs.writeFile(entry, `import { Validator } from 'ata-validator'
const user = new Validator({ type: 'object', required: ['id', 'email'], additionalProperties: false, properties: { id: { type: 'integer', minimum: 1 }, email: { type: 'string', format: 'email' } } })
const tags = new Validator({ type: 'array', items: { type: 'string', pattern: '^[a-z-]+$' }, uniqueItems: true, maxItems: 8 })
export const ok = (d: unknown) => user.isValidObject(d) && tags.isValidObject((d as any).tags)
export const why = (d: unknown) => user.validate(d).errors
`)
    const result = await esbuild.build({
      entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
      absWorkingDir: dir,
      // The temp dir has no node_modules; the wrappers' imports stay external.
      external: ['ata-validator', 'ata-validator/*'],
      plugins: [unplugin.esbuild({ schemas: 'none/**/*.json', root: dir, verify: 20 })],
    })
    assert.equal(result.errors.length, 0)
    const out = result.outputFiles[0].text
    assert.ok(out.includes('__ataCompiled0') && out.includes('__ataCompiled1'), 'both validators compiled away')
    assert.ok(!out.includes('new Validator('))
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('throws, with the document, when a compiled module disagrees with the runtime', async () => {
    const { runVerify } = await import('../src/index.js')
    const entries = new Map([['/app/a.ts:2', { schema: { type: 'string' }, src: 'export const isValid = () => true\n' }]])
    // A verify API whose verifySource reports a disagreement stands in for a
    // module that would; the plugin's own path from there is what is tested.
    const api = { verify: { ...ata.verify, verifySource: async () => ({ schema: '/app/a.ts:2', module: 'm', documents: 3, generated: 3, samples: 0, valid: 2, agree: 2, disagreements: [{ source: 'generated #2', document: '"x"', runtime: 'valid', module: 'invalid minLength@', runtimeIsValid: true, moduleIsValid: false }], stale: false, missing: false, ataVersion: null, error: null }) } }
    await assert.rejects(() => runVerify(entries, api, true, null), /verify: 1 compiled validator\(s\) disagree with the runtime[\s\S]*generated #2[\s\S]*"x"/)
    assert.equal(entries.size, 0, 'the list is consumed either way')
    const fine = { verify: { ...ata.verify, verifySource: async () => ({ schema: 's', module: 'm', documents: 3, generated: 3, samples: 0, valid: 2, agree: 3, disagreements: [], stale: false, missing: false, ataVersion: '1.61.0', error: null }) } }
    const lines = []
    await runVerify(new Map([['k', { schema: {}, src: '' }]]), fine, 7, { info: (l) => lines.push(l) })
    assert.match(lines[0], /verify: 1 compiled validator\(s\) answer as the runtime does on 7 generated documents each/)
    await assert.rejects(() => runVerify(new Map(), { verify: null }, true, null), /needs ata-validator 1.61.0/)
  })
})
