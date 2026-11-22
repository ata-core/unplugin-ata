// The report at the end of a build has to reach the person building. Vite,
// webpack and Rspack hand the plugin a logger; esbuild, Rollup and Rolldown do
// not, and there the report was never printed: a `new Validator` kept on the
// runtime, or a zodResolver call left with zod, went unsaid.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuildPlugin from '../src/esbuild.js'
import rollupPlugin from '../src/rollup.js'
import rolldownPlugin from '../src/rolldown.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = `import { Validator } from 'ata-validator'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { other } from './other.js'
const a = new Validator({ type: 'string' })
const b = new Validator(other)
const loose = z.object({ a: z.string() }).catchall(z.string())
const strict = z.strictObject({ a: z.email(), n: z.int().optional() })
export const run = (x) => [a.isValidObject(x), b.isValidObject(x)]
export const r1 = zodResolver(loose)
export const r2 = zodResolver(strict)
`
const KEPT = /kept on the runtime: main\.js:6 /
const LEFT = /left as written: main\.js:10 zodResolver\(loose\): the schema: a loose or catchall object is not carried/
const COUNT = /zodResolver: 1 of 2 calls compiled at build time, 1 left as written with zod/
const EXTERNAL = ['ata-validator', 'zod', '@hookform/resolvers', '@hookform/resolvers/zod', 'react-hook-form', /^ata-validator\//]

describe('the build report reaches the build log', () => {
  let dir
  before(async () => {
    dir = await fs.mkdtemp(path.join(here, 'fixtures', 'report-logger-'))
    await fs.writeFile(path.join(dir, 'main.js'), SOURCE)
    await fs.writeFile(path.join(dir, 'other.js'), `export const other = JSON.parse('{}')\n`)
  })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

  const esbuildLines = async (logLevel, options = {}) => {
    const esbuild = await import('esbuild')
    const lines = { log: [], warn: [] }
    const log = console.log; const warn = console.warn
    console.log = (...a) => lines.log.push(a.join(' ')); console.warn = (...a) => lines.warn.push(a.join(' '))
    try {
      await esbuild.build({ absWorkingDir: dir, entryPoints: ['main.js'], bundle: true, write: false, format: 'esm', packages: 'external', ...(logLevel ? { logLevel } : {}), plugins: [esbuildPlugin({ verify: false, ...options })] })
    } finally { console.log = log; console.warn = warn }
    return lines
  }

  it('esbuild: a kept validator is a warning at the default log level, the rest is said from info up', async () => {
    const quiet = await esbuildLines(undefined)
    assert.equal(quiet.warn.filter((l) => KEPT.test(l)).length, 1)
    assert.equal(quiet.log.length, 0)
    const info = await esbuildLines('info')
    assert.equal(info.warn.filter((l) => KEPT.test(l)).length, 1)
    assert.ok(info.log.some((l) => COUNT.test(l)), info.log.join('\n'))
    assert.ok(info.log.some((l) => LEFT.test(l)), info.log.join('\n'))
  })
  it('esbuild: nothing is printed under logLevel silent or error, with report: false, or beside a logger of the caller', async () => {
    for (const level of ['silent', 'error']) { const l = await esbuildLines(level); assert.equal(l.log.length + l.warn.length, 0, level) }
    const off = await esbuildLines('info', { report: false })
    assert.ok(![...off.log, ...off.warn].some((l) => KEPT.test(l) || LEFT.test(l) || COUNT.test(l)))
    const mine = []
    const own = await esbuildLines('info', { logger: { info: (m) => mine.push(m), warn: (m) => mine.push(m) } })
    assert.equal(own.log.length + own.warn.length, 0)
    assert.ok(mine.some((l) => KEPT.test(l)) && mine.some((l) => LEFT.test(l)))
  })
  for (const [name, load, plugin] of [['Rollup', () => import('rollup').then((m) => m.rollup), rollupPlugin], ['Rolldown', () => import('rolldown').then((m) => m.rolldown), rolldownPlugin]]) {
    it(`${name}: the report goes through the plugin context, at the build's own levels`, async () => {
      const bundle = await load()
      const logs = []
      const b = await bundle({ input: path.join(dir, 'main.js'), external: EXTERNAL, onLog: (level, log) => { logs.push([level, log.message]) }, plugins: [plugin({ verify: false, root: dir })] })
      await b.generate({})
      assert.equal(logs.filter(([level, m]) => level === 'warn' && KEPT.test(m)).length, 1, JSON.stringify(logs))
      assert.ok(logs.some(([level, m]) => level === 'info' && COUNT.test(m)), JSON.stringify(logs))
      assert.ok(logs.some(([level, m]) => level === 'info' && LEFT.test(m)), JSON.stringify(logs))
    })
  }
})
