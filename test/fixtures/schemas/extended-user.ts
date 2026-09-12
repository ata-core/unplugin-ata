// Compose a schema by importing a base JSON schema and extending it in TS.
// Example contributed by @SukeshP1995 (PR #1).
import user from './user.json' with { type: 'json' }

const schema = user as { properties: Record<string, unknown> }
schema.properties.age = { type: 'number' }

export default user
