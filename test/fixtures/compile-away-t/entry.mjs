import { Validator } from 'ata-validator'
import { t } from 'ata-validator/t'

// A schema written with the builder, as a user writes it, using most of it.
const Address = t.object({ street: t.string({ minLength: 1 }), zip: t.optional(t.string({ pattern: '^[0-9]{5}$' })) })
const User = t.object({
  id: t.integer({ minimum: 1 }),
  name: t.string({ minLength: 1, maxLength: 64 }),
  role: t.enum(['admin', 'user']),
  status: t.union([t.literal('active'), t.literal('banned')]),
  nick: t.optional(t.string()),
  tags: t.array(t.string(), { maxItems: 3 }),
  point: t.tuple([t.number(), t.number()]),
  meta: t.record(t.boolean()),
  address: Address,
  note: t.union([t.string(), t.null()]),
})
const Public = t.omit(User, ['meta'])
const Patch = t.partial(t.pick(User, ['name', 'nick']))

const user = new Validator(User)
const pub = new Validator(Public)
const patch = new Validator(Patch)

export { User, Public, Patch }
export const validate = (d) => user.validate(d)
export const isValidObject = (d) => user.isValidObject(d)
export const validateJSON = (s) => user.validateJSON(s)
export const pubOk = (d) => pub.isValidObject(d)
export const patchCheck = (d) => patch.validate(d)
