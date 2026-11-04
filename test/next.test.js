// Next.js: withAta() wires the webpack plugin and the Turbopack loader, and
// keeps the rest of the config. The loader, run as Turbopack runs a webpack
// loader, rewrites a file the way the plugin's transform does, and leaves a
// file outside the application or without a validator unchanged.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import withAta from '../src/next.js'

const require = createRequire(import.meta.url)
const loader = require('../src/turbopack.cjs')
const here = path.dirname(fileURLToPath(import.meta.url))

const run = (source, resourcePath, options = {}) => new Promise((resolve, reject) => {
  loader.call({ async: () => (err, code) => (err ? reject(err) : resolve(code)), getOptions: () => options, resourcePath, rootContext: here }, source)
})

const FORM = "import { Validator } from 'ata-validator'\nconst v = new Validator({ type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'] })\nexport const check = (d) => v.validate(d)\n"

describe('withAta', () => {
  it('adds the Turbopack rule and the webpack plugin, keeping the config', () => {
    let ran = false
    const cfg = withAta({ reactStrictMode: true, turbopack: { rules: { '*.svg': { loaders: ['svg'] } } }, webpack: (c) => { ran = true; return c } })
    assert.equal(cfg.reactStrictMode, true)
    assert.deepEqual(cfg.turbopack.rules['*.svg'], { loaders: ['svg'] })
    const rule = cfg.turbopack.rules['*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}']
    assert.equal(rule.loaders[0].loader, require.resolve('../src/turbopack.cjs'))
    const webpackConfig = { plugins: [] }
    assert.equal(cfg.webpack(webpackConfig, {}), webpackConfig)
    assert.equal(webpackConfig.plugins.length, 1)
    assert.ok(ran, 'the config\'s own webpack function did not run')
  })
  it('refuses to overwrite a rule of the same pattern', () => {
    assert.throws(() => withAta({ turbopack: { rules: { '*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}': { loaders: [] } } } }), /already has/)
  })
})

describe('the Turbopack loader', () => {
  it('compiles a validator away', async () => {
    const out = await run(FORM, path.join(here, 'fixtures', 'form.js'))
    assert.notEqual(out, FORM)
    assert.doesNotMatch(out, /new Validator\(/)
  })
  it('leaves node_modules and files without ata-validator alone', async () => {
    assert.equal(await run(FORM, path.join(here, 'node_modules', 'x', 'form.js')), FORM)
    const plain = 'export const x = 1\n'
    assert.equal(await run(plain, path.join(here, 'fixtures', 'plain.js')), plain)
  })
  it('passes options to the plugin', async () => {
    assert.equal(await run(FORM, path.join(here, 'fixtures', 'off.js'), { compileAway: false }), FORM)
  })
})
