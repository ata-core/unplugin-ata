import { Validator } from 'ata-validator'
import { t } from 'ata-validator/t'

// Schemas that only the validator uses: once it is compiled away, nothing
// needs the builder, and it leaves the bundle.
const Item = t.object({ sku: t.string({ minLength: 1 }), qty: t.optional(t.integer({ minimum: 1 })) })
const Order = t.object({ id: t.integer(), items: t.array(Item), status: t.enum(['open', 'paid']) })

const order = new Validator(Order)
export const check = (d) => order.validate(d)
