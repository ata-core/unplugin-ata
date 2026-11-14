// sharedErrors 'auto' never makes a bundle bigger than self-contained modules
// would: for one schema, of two kinds and of sizes on both sides of where the
// shared runtime starts to pay, in a minified esbuild bundle for a browser and
// for a Node target. The bar (ERROR_RUNTIME_COST in src/compile-away.js) was
// 24000 and wrote larger bundles for schemas between it and these figures.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

import esbuildPlugin from '../src/esbuild.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const described = (n) => {
  const props = {}
  for (let i = 0; i < n; i++) props['field' + i] = { description: `Field ${i}, described at the length published schemas describe their fields, so the descriptions are most of the text.`, ...(i % 3 === 0 ? { type: 'string', maxLength: 40, pattern: '^[a-z]+$' } : i % 3 === 1 ? { type: 'integer', minimum: 0 } : { type: 'object', properties: { x: { type: 'number' }, y: { enum: ['a', 'b', 'c'] } }, required: ['x'] }) }
  return { type: 'object', properties: props, required: ['field0', 'field1'] }
}
const bare = (n) => {
  const props = {}
  for (let i = 0; i < n; i++) props['f' + i] = i % 4 === 0 ? { type: 'string', minLength: 1, maxLength: 80, ...(i % 8 === 0 ? { format: 'email' } : {}) } : i % 4 === 1 ? { type: 'integer', minimum: 0, maximum: 1000 } : i % 4 === 2 ? { type: 'boolean' } : { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] }, maxItems: 5 }
  return { type: 'object', properties: props, required: ['f0', 'f1'], additionalProperties: false }
}

describe('sharedErrors auto: never a bigger bundle', () => {
  let dir
  before(async () => { dir = await fs.mkdtemp(path.join(here, 'fixtures', 'shared-cost-')) })
  after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })
  const size = async (file, platform, sharedErrors) => {
    const { build } = await import('esbuild')
    const r = await build({ entryPoints: [file], absWorkingDir: dir, nodePaths: [path.join(here, '..', 'node_modules')], bundle: true, minify: true, format: 'esm', platform, write: false, logLevel: 'silent', plugins: [esbuildPlugin({ schemas: 'none/*.json', verify: false, report: false, ir: false, sharedErrors })] })
    return zlib.gzipSync(r.outputFiles[0].text).length
  }
  for (const [kind, make, sizes] of [['described fields', described, [600, 800, 1500]], ['bare fields', bare, [900, 1200, 3000]]]) {
    it(kind, async () => {
      const seen = []
      for (const n of sizes) {
        const file = path.join(dir, `${kind.split(' ')[0]}-${n}.mjs`)
        await fs.writeFile(file, `import { Validator } from 'ata-validator'\nconst v = new Validator(${JSON.stringify(make(n))})\nexport const validate = (x) => v.validate(x)\n`)
        for (const platform of ['browser', 'node']) {
          const auto = await size(file, platform, 'auto')
          const self = await size(file, platform, false)
          seen.push(`${n} ${platform}: ${auto - self}`)
          assert.ok(auto <= self, `${kind}, ${n} fields, ${platform}: auto ${auto} bytes against ${self} self-contained`)
        }
      }
      // The largest schema of each kind is past the bar and gains.
      const last = sizes[sizes.length - 1]
      for (const platform of ['browser', 'node']) assert.ok(seen.find((x) => x.startsWith(`${last} ${platform}`)).split(': ')[1] < 0, `the largest schema takes the shared runtime: ${seen.join(', ')}`)
    })
  }
})
