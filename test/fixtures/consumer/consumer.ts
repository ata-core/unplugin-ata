import validate, { type Login, isValid } from './login.schema'

const ok: Login = { user: 'mert' }
const r = validate(ok)
if (r.valid) {
  // no errors on a valid value
}
const probe: unknown = JSON.parse('{}')
if (isValid(probe)) {
  const u: string = probe.user // narrowed to Login
  void u
}
// @ts-expect-error user must be a string (proves the type is real)
const bad: Login = { user: 123 }
void bad
