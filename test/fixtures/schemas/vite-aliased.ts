// Imports a shared fragment via a Vite resolve.alias entry (@fields).
import { idField } from '@fields'

export default {
  type: 'object',
  properties: { id: idField },
  required: ['id'],
}
