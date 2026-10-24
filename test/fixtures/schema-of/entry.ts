import { Validator, schemaOf } from 'ata-validator'
import type { User } from './types.ts'
const user = new Validator(schemaOf<User>())
export const check = (d: unknown) => user.validate(d)
export const schema = schemaOf<User>()
