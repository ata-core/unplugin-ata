// A schema authored as a plain JS module (default export).
export default {
  type: 'object',
  properties: {
    sku: { type: 'string', minLength: 1 },
    price: { type: 'number', minimum: 0 },
  },
  required: ['sku', 'price'],
}
