// A file that opens with a directive ('use client', 'use server', 'use
// strict') keeps it first: the imports a rewrite adds go after it. Written
// before the directive they made it an ordinary expression, and Next.js
// failed the build of every client component that held a validator.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '@babel/parser'

import { compileAway } from '../src/compile-away.js'
import { __internal } from '../src/core.js'

const ata = await __internal.loadAta()
const schema = `{ type: 'object', properties: { email: { type: 'string', format: 'email' }, n: { type: 'integer', minimum: 1 } }, required: ['email'], additionalProperties: false }`
const uses = {
  'validate()': 'export const run = (d) => v.validate(d)',
  'isValidObject()': 'export const ok = (d) => v.isValidObject(d)',
  'validateJSON()': 'export const run = (t) => v.validateJSON(t)',
  'handed over': 'export const pass = (f) => f(v)',
}

describe('compile-away, a leading directive', () => {
  for (const directive of [`'use client'`, `"use server";`, `'use strict'`]) {
    for (const [use, body] of Object.entries(uses)) {
      for (const options of [{ ir: true }, { ir: true, table: true }, { ir: false }, { ir: false, sharedErrors: true }]) {
        it(`${directive} stays first: ${use}, ${JSON.stringify(options)}`, () => {
          const code = `${directive}\n// a form\nimport { Validator } from 'ata-validator'\nconst v = new Validator(${schema})\n${body}\n`
          const out = compileAway(code, '/app/form.jsx', ata, options)
          assert.ok(out && out.replaced === 1, 'the call is replaced')
          const program = parse(out.code, { sourceType: 'module', plugins: ['jsx'] }).program
          assert.equal(program.directives.length, 1, out.code.slice(0, 200))
          assert.equal(program.directives[0].value.value, directive.replace(/['";]/g, ''))
          assert.ok(program.body.length > 0 && program.body[0].type === 'ImportDeclaration')
        })
      }
    }
  }
  it('two directives keep their order, and a file without one is written as before', () => {
    const tail = `import { Validator } from 'ata-validator'\nconst v = new Validator(${schema})\nexport const run = (d) => v.validate(d)\n`
    const two = compileAway(`'use client'\n'use strict'\n${tail}`, '/app/form.jsx', ata, { ir: true })
    assert.deepEqual(parse(two.code, { sourceType: 'module' }).program.directives.map((d) => d.value.value), ['use client', 'use strict'])
    const none = compileAway(tail, '/app/form.jsx', ata, { ir: true })
    assert.ok(none.code.startsWith('import '))
  })
})
