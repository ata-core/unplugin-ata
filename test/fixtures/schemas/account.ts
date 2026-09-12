// A schema authored in TypeScript. `as const` and the type alias exercise
// syntax that must be stripped/transpiled before the object is usable.
type Schema = Record<string, unknown>

const schema = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    email: { type: 'string', minLength: 3 },
  },
  required: ['id', 'email'],
} as const satisfies Schema

export default schema
