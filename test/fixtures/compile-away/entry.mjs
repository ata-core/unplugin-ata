import { Validator, defineSchema } from 'ata-validator'

const Body = {
  type: 'object',
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    email: { type: 'string', format: 'email' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name'],
  additionalProperties: false,
}

const check = new Validator(Body)
const shortName = new Validator(defineSchema({ type: 'string', minLength: 2 }))

export const validate = (d) => check.validate(d)
export const isValidObject = (d) => check.isValidObject(d)
export const validateJSON = (t) => check.validateJSON(t)
export const isValidJSON = (t) => check.isValidJSON(t)
export const nameOk = (s) => shortName.isValidObject(s)
const Settings = {
  type: 'object',
  properties: {
    theme: { type: 'string', enum: ['light', 'dark'], default: 'light' },
    notify: { type: 'object', properties: { email: { type: 'boolean', default: true }, every: { type: 'integer', minimum: 1, default: 7 } }, default: {} },
  },
}
const settings = new Validator(Settings)
export const validateSettings = (d) => settings.validate(d)
// The one option compile-away takes: defaults are left unfilled.
const kNoDefaults = { useDefaults: false }
const settingsAsIs = new Validator(Settings, kNoDefaults)
export const validateSettingsAsIs = (d) => settingsAsIs.validate(d)

export { Body, Settings }
