import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { compile } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const consumerDir = path.join(here, 'fixtures', 'consumer')

async function clean() {
  for (const f of ['login.schema.js', 'login.schema.d.ts']) {
    await fs.unlink(path.join(consumerDir, f)).catch(() => {})
  }
}

describe('typed import', () => {
  before(clean)
  after(clean)

  it('import validate, { type Login, isValid } from ./login.schema type-checks', async () => {
    await compile({ schemas: '*.schema.json', root: consumerDir })
    await fs.access(path.join(consumerDir, 'login.schema.js'))
    await fs.access(path.join(consumerDir, 'login.schema.d.ts'))

    const tsc = path.join(here, '..', 'node_modules', '.bin', 'tsc')
    const res = spawnSync(tsc, ['-p', path.join(consumerDir, 'tsconfig.json')], { encoding: 'utf8' })
    assert.equal(res.status, 0, `tsc failed:\n${res.stdout}\n${res.stderr}`)
  })
})
