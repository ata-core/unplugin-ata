import { ataResolver } from '@hookform/resolvers/ata-validator'

// A form whose fields share a definition, with defaults, and keywords the
// collector reports out of declaration order (format before pattern,
// additionalProperties before properties).
export const Signup = {
  type: 'object',
  $defs: {
    address: {
      type: 'object',
      properties: {
        street: { type: 'string', minLength: 3 },
        zip: { type: 'string', pattern: '^[0-9]{5}$', minLength: 5 },
        country: { type: 'string', enum: ['TR', 'DE', 'US'], default: 'TR' },
      },
      required: ['street', 'zip'],
    },
  },
  properties: {
    name: { type: 'string', minLength: 2 },
    email: { type: 'string', pattern: '^[a-z]', format: 'email' },
    home: { $ref: '#/$defs/address' },
    work: { $ref: '#/$defs/address' },
    newsletter: { type: 'boolean', default: false },
  },
  required: ['name', 'email', 'home'],
  additionalProperties: false,
}

export const resolve = ataResolver(Signup)
export const resolveRaw = ataResolver(Signup, undefined, { raw: true })
export const resolveEmptyOptions = ataResolver(Signup, {})
