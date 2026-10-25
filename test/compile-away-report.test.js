// The build's report: every `new Validator(...)` the transform keeps on the
// runtime comes back with its line and the reason, beside the count of calls
// it replaced, so a reader learns why the runtime compiler is still in the
// bundle. Nothing in the emitted code changes for it.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const ata = await __internal.loadAta()
const can = !!(ata && ata.compiledModuleFor)

describe('compileAway report', { skip: can ? false : 'ata-validator with compiledModuleFor is not installed' }, () => {
  it('names each kept call with its line and reason, and counts the replaced ones', () => {
    const code = `import { Validator } from 'ata-validator'
import { schema as remote } from './elsewhere.js'
const a = new Validator({ type: 'string' })
const b = new Validator(remote)
export const c = new Validator({ type: 'number' })
const d = new Validator({ type: 'object' }, { coerceTypes: 'array', unknownOption: 1 })
const e = new Validator({ type: 'integer' }, { verbose: true }, 'extra')
export const run = (x) => [a.isValidObject(x), b.isValidObject(x), c.isValidObject(x), d.isValidObject(x), e.isValidObject(x)]
`
    const kept = []
    const out = compileAway(code, '/app/src/checks.ts', ata, { kept })
    assert.ok(out && out.code, 'something was replaced')
    assert.equal(out.replaced, 1)
    assert.equal(kept.length, 4)
    const byLine = Object.fromEntries(kept.map((k) => [k.line, k.reason]))
    assert.match(byLine[4], /schema is not a value the build can read/)
    assert.match(byLine[5], /property read, an export, a return or a reassignment/)
    assert.match(byLine[6], /options are not a literal the build can read, or name an option/)
    assert.match(byLine[7], /the call has 3 arguments/)
  })

  it('reports kept calls even when nothing was replaced, and the return stays null then', () => {
    const kept = []
    const only = compileAway(`import { Validator } from 'ata-validator'
import { s } from './s.js'
const v = new Validator(s)
export const ok = (x) => v.isValidObject(x)
`, '/app/src/one.ts', ata, { kept })
    assert.equal(only, null)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].line, 3)
    const none = []
    assert.equal(compileAway(`export const x = 1\n`, '/app/src/none.ts', ata, { kept: none }), null)
    assert.equal(none.length, 0)
  })
})
