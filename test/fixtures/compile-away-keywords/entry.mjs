import { Validator } from 'ata-validator'
import { withKeywords } from '@ata-project/keywords'

// The shape of schemabenchmarks' product entry: a Date checked by the
// instanceof keyword, nested in arrays, next to ordinary constraints.
const dateSchema = { type: 'object', instanceof: 'Date', required: [] }
const image = {
  type: 'object',
  properties: { id: { type: 'number' }, created: dateSchema, title: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['id', 'created', 'title'],
}
const Product = {
  type: 'object',
  properties: { id: { type: 'number' }, created: dateSchema, title: { type: 'string', minLength: 1 }, images: { type: 'array', items: image } },
  required: ['id', 'created', 'title', 'images'],
}

const product = withKeywords(new Validator(Product))
const productOk = withKeywords(new Validator({ type: 'object', properties: { at: { instanceof: 'Date' } } }))

export { Product }
export const validate = (d) => product.validate(d)
export const isValidObject = (d) => product.isValidObject(d)
export const validateJSON = (t) => product.validateJSON(t)
export const isValidJSON = (t) => product.isValidJSON(t)
export const atOk = (d) => productOk.isValidObject(d)
