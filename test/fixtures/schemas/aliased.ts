// Imports a shared fragment via a tsconfig `paths` alias (#shared/*).
import { idField } from '#shared/fields'

export default {
  type: 'object',
  properties: { id: idField },
  required: ['id'],
}
