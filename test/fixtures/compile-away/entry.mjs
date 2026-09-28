import { Validator, defineSchema } from 'ata-validator'

const Body = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    email: { type: 'string', format: 'email' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name'],
  additionalProperties: false,
}

const check = new Validator(Body)
const shortName = new Validator(defineSchema({ type: 'string', minLength: 2 }))

export const validate = (d) => check.validate(d)
export const isValidObject = (d) => check.isValidObject(d)
export const validateJSON = (t) => check.validateJSON(t)
export const isValidJSON = (t) => check.isValidJSON(t)
export const nameOk = (s) => shortName.isValidObject(s)
export { Body }
