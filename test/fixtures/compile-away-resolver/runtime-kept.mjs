import { ataResolver } from '@hookform/resolvers/ata-validator'

const Body = { type: 'object', properties: { age: { type: 'integer' } } }

// Validator options have no compiled equivalent, and a schema the build cannot read stays dynamic.
export const coerce = ataResolver(Body, { coerceTypes: true })
export const dynamic = (schema) => ataResolver(schema)
