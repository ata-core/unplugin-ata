# @ata-project/unplugin

Compiles [ata-validator](https://ata-validator.com) at build time, in Vite, Webpack, Rollup, Rolldown, esbuild, Rspack and Bun. One plugin, built on [unplugin](https://github.com/unjs/unplugin).

Each `new Validator(schema)` in your code whose schema the build can read becomes a compiled validator that gives the same answers, errors and filled defaults, and the compiler stays out of the page. Your code does not change. An order form with six fields, its errors read on submit, goes from 55.3 KB gzipped on the runtime to 4.5 KB, and on a throttled phone profile is ready in 372 ms instead of 779 (ata-validator 1.63.0 and this plugin's 0.12.0; the measurements are in [`ir`](#ir-a-smaller-compiled-validator) and in ata-validator's README). See [compileAway](#compileaway-keep-new-validator-drop-the-compiler).

It also compiles JSON Schema files into self-contained modules with TypeScript declarations. Such a module imports nothing; a small schema compiles to about 1.3 KB gzipped and a ten-field one to about 2.6 KB, full error detail included, on ata-validator 1.36.0. It exports `validate`, `isValid` and the inferred type, and runs anywhere plain JavaScript runs. Schemas can be authored as `.json`, `.js` or `.ts`.

## Install

```bash
npm install --save-dev @ata-project/unplugin ata-validator
```

`ata-validator` is a peer dependency. A page's build uses it at build time only, and the page carries none of it. A generated validator file that a server imports without bundling (`<module>.validators.mjs`, the OpenAPI validators) runs on the runtime there, so that server needs `ata-validator` in its `dependencies`.

## Setup

Vite:

```ts
// vite.config.ts
import ata from '@ata-project/unplugin/vite'

export default {
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
}
```

Webpack:

```js
// webpack.config.js
const ata = require('@ata-project/unplugin/webpack')

module.exports = {
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
}
```

Rollup:

```js
// rollup.config.js
import ata from '@ata-project/unplugin/rollup'

export default {
  // Rollup has no project root; tell the plugin where the globs start.
  plugins: [ata({ schemas: 'src/**/*.schema.json', root: process.cwd() })],
}
```

esbuild:

```js
import { build } from 'esbuild'
import ata from '@ata-project/unplugin/esbuild'

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
})
```

Rspack:

```js
// rspack.config.js
const ata = require('@ata-project/unplugin/rspack')

module.exports = {
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
}
```

Bun:

```js
// build.ts
import ata from '@ata-project/unplugin/bun'

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
})
```

The same call with `compile: { outfile: './app' }` writes an executable in
which the compiled validators stand in for the runtime (`bun build --compile`
on the command line takes no plugins, so the build goes through `Bun.build`).

Rolldown:

```js
// rolldown.config.js
import ata from '@ata-project/unplugin/rolldown'

export default {
  plugins: [ata({ schemas: 'src/**/*.schema.json', root: process.cwd() })],
}
```

Next.js: `withAta` wraps the config and covers both bundlers Next runs,
Turbopack (the default since Next.js 16) through a loader and webpack
(`next build --webpack`) through the plugin. The rest of the config is kept.

```js
// next.config.mjs
import withAta from '@ata-project/unplugin/next'

export default withAta({ /* your config */ }, { /* plugin options */ })
```

On a Next.js 16 page with one order form that reads its errors, the
validator adds 4.2 KB gzipped to the first load under Turbopack and 4.6 KB
under webpack, against 67.5 and 58.3 KB for the runtime `Validator`. Under
Turbopack by hand, the loader is `@ata-project/unplugin/turbopack` in
`turbopack.rules`.

## Keep your schema library, lose it from the page

A client that writes its schemas in zod, valibot or TypeBox can keep them and still ship a page with neither the library nor a validator runtime. The `zod` option names modules that export zod 4 schemas, and `from` names modules of any of the three, each export by its own library; the build loads each module (TypeScript through jiti), converts every exported schema (zod's own `z.toJSONSchema`, valibot's `@valibot/to-json-schema`, a TypeBox schema as written), and writes `<module>.validators.mjs` and `.d.mts` beside it, one `{ validate, isValidObject }` per export, which the page's build compiles away like any other validator.

```js
ata({ zod: 'src/events/*.ts' })
```

```ts
// src/events/widget.ts, unchanged
export const widgetEvent = z.object({ event: z.enum(['view', 'click']), widgetId: z.string().min(1), position: z.number().int().min(0) })
```

```ts
// the page
import { widgetEvent, type WidgetEventInput } from './events/widget.validators.mjs'
const r = widgetEvent.validate(event)
if (!r.valid) log(r.errors.map((e) => ({ path: e.instancePath, message: e.message })))
```

The page answers as zod does. The schema written is the input schema (`io: 'input'`), so an unknown key passes as it passes `z.object`; the key is left in place rather than stripped, and `z.strictObject` stays closed. Where zod writes its own regex beside a format name (email, uuid, url), the regex alone is kept, since zod's verdict is its regex. The type the page sees is the library's own: for a TypeScript module the declarations say `z.input<typeof import('./widget.js').widgetEvent>`, `InferInput<...>` for valibot or `Static<...>` for TypeBox, so `WidgetEventInput` is what the library infers, down to the branded and literal types; a JavaScript module gets a type written from the schema. Errors come in the plain shape by default, keyword, `instancePath`, `schemaPath`, `params` and `message`; `validatorOptions: { richErrors: true }` asks for ata's rich shape.

A `.refine(fn)` or `.transform(fn)` whose function reads nothing but its own parameter is carried: its text is written into the module and run on the value at its place once the compiled check has passed, in zod's order, so a refine written after a transform sees the transformed value. A refine reports with zod's message and path (`refine((d) => d.from <= d.to, { message, path: ['to'] })` reports at `/dates/to`); a transform's result is written into the data `validate()` hands back, as a filled default is, so `validate(input).data` is what zod's `parse` gives, and `isValidObject()` leaves the input as it was. Of 337 refine calls in 195 public TypeScript files, 258 are such functions, and 88 of 153 transforms. Three refines on a three-field signup schema take the page module from 1.2 KB to 1.7 KB gzipped, the runner included. A `.pipe()` into a second schema is carried as a second compiled check on the value as it stands, at its place. A function that closes over an outside name (`(v) => v.length < MAX`), a `superRefine` or a transform that takes `ctx` (zod exposes no function for the first, the second can raise issues), a `preprocess` (it runs before the schema, which the compiled check cannot), or a refine inside a union, has no form a page can carry, and `z.toJSONSchema` drops it without a word, so a page built from such a schema would accept what the zod schema rejects. The build refuses it by export and path instead: `widget.ts export signup: $.n: refine closes over MAX, $.name: transform`. Write the rule as a constraint (`pattern`, `minimum`, `enum`), move the transform after validation, or set `dropRefinements: true` to take them out knowingly, which the build reports; a server that keeps zod still runs them. A zod type JSON Schema cannot carry (`z.date()`, `z.map()`, a function) is refused the same way. One difference in the error list: a carried refine's error appears once the schema's own checks pass, where zod lists both at once; the verdict is the same.

Three more things zod does that its JSON Schema does not say are refused the same way, by export and path. A check written after `trim()`, `toLowerCase()`, `toUpperCase()` or `normalize()` sees the rewritten value in zod (`z.string().trim().min(1)` rejects `"  "`), where the JSON Schema would count the value as it came and accept it. `z.coerce.number()` converts before it checks and takes `"5"`. `.catch(value)` takes anything. A rewrite with nothing checked after it (`z.string().min(1).trim()`) is carried like a transform, so `validate(input).data` holds the trimmed value. Up to 0.15.0 these were converted without a word, and the page answered differently from zod on those values.

valibot's `v.object` passes an unknown key as `z.object` does, and the page leaves it in place where valibot's output would drop it; `check` and `transform` are carried the same way, in the order of the pipe; a validation written after a transform, a `rawCheck`, `rawTransform` or `checkItems` is refused. A TypeBox schema is used as written; a kind outside the standard set, a `Transform`, a `$ref` out of the document, or a `format` registered in `FormatRegistry` (a page would pass it unchecked) is refused by path.

Measured on three event schemas, one of them a union of objects, esbuild minified, gzip level 9, ata-validator 1.63.1, zod 4.6.7: the page carries 3.9 KB with the compiled validators and 93.0 KB with zod; one schema alone is 1.1 KB. The same four-field event schema in TypeBox 0.34.52: 1.1 KB compiled against 25.5 KB with `Value.Check` on the page (a `Type.Union` of literals is written as an `enum`, the same verdict without the branch kernels). In valibot 1.5.0, which is modular and small: 1.1 KB compiled against 1.7 KB with valibot on the page, so the saving there is 0.6 KB on this schema; what a valibot client gains is the compiled path and the server reading the same module, not bytes. The module beside the zod file is plain source, so a server can import it too and run the same schema on the runtime.

## One OpenAPI document for the server and the page

Point the plugin at the API's OpenAPI document (3.0 or 3.1; YAML needs the
`yaml` package) and it writes the request body validators beside it:

```js
// vite.config.js
ata({ openapi: 'openapi.json' })
```

```js
// any page
import { createUserBody } from './openapi.validators.mjs'
const r = createUserBody.validate(form)
```

`openapi.validators.mjs` is plain source: one `new Validator(schema)` per
operation with a JSON body, named after its `operationId` in camel case
(`create-user` gives `createUserBody`; with no `operationId`, the method
and path: `post /users` gives `postUsersBody`; two operations that would
share a name stop the build with both named), the schema from `operationSchemas` in
`ata-validator/openapi` (references into `components.schemas` kept,
OpenAPI 3.0's `nullable` and boolean exclusive bounds read as 3.0 defines
them). A server imports the same file and runs it on the runtime; the page's
build compiles each validator like any other, so the two check the same
schema. On a nine-field signup operation the server running the file and the
page running the compiled build disagreed on 0 of 50,000 generated
documents, every error compared, and the page's validation added 3.78 KB
gzipped to a Vite + React first load. `openapi.validators.d.mts` types each
body (`CreateUserBody`) and validator. `validatorOptions` passes
`richErrors`, `useDefaults` or `assertFormat` to every validator:
`openapi: { file: 'openapi.json', validatorOptions: { richErrors: false } }`.
Under `vite dev` an edit to the document writes the module again; under
webpack's and Rollup's watch mode it is written again at the next build
start. The guarantee holds when the server runs the same ata-validator
version the page is built with.

## The `.schema.json` convention

Name a schema `user.schema.json` and import a typed validator by its name:

```ts
import validate, { type User, isValid } from './user.schema'

const r = validate(input)
if (r.valid) {
  // input matched the schema
}
if (isValid(input)) {
  input.id // narrowed to User
}
```

The plugin writes `user.schema.js` and `user.schema.d.ts` next to the schema.
The default export is the `validate` function; `validate`, `isValid` and the
inferred type are also named exports. The type name comes from the schema's
`title`, then its `$id`, then the file name.

Add the generated files to `.gitignore`:

```
*.schema.js
*.schema.d.ts
```

Other sources (`.json` without the `.schema` suffix, `.js`, `.ts`) produce
`<name>.validator.mjs` and `<name>.validator.d.mts`.

## Options

| Option | Default | Description |
|---|---|---|
| `schemas` | `**/*.schema.json` | Glob or globs, relative to the root. `node_modules` is skipped. |
| `zod` | none | Modules exporting zod 4 schemas, by glob; validators written beside each. See [Keep your schema library](#keep-your-schema-library-lose-it-from-the-page). |
| `from` | none | Like `zod`, for modules of zod, valibot or TypeBox schemas, each export by its own library. |
| `outDir` | next to each schema | Directory for generated files, mirroring the source layout. |
| `format` | `'esm'` | `'esm'` or `'cjs'`. |
| `abortEarly` | `false` | Emit the smaller validator that stops at the first failure. |
| `types` | `true` | Emit a `.d.ts` next to each validator. |
| `nameFromFile` | file name in PascalCase | Type name for schemas without `title` or `$id`. |
| `root` | from the bundler | Where the globs resolve from. Vite's root, Webpack's and Rspack's `context`, esbuild's `absWorkingDir` and Bun.build's `root` are read; Rollup and Rolldown need it passed. |
| `alias` | Vite's `resolve.alias` | Import aliases inside `.ts` schema files. tsconfig `paths` work without configuration. |
| `compileAway` | `true` | Replace `new Validator(schema)` in your code with a validator compiled at build time, where that gives the same results. See below. Needs ata-validator 1.36.0; with an older version the runtime stays, and a warning is printed only if you set the option yourself. |
| `bunTarget` | from `compile.aot` | Under `Bun.build({ compile: { aot: true } })`, write a `.bun.ts` beside each module compiled from the globs: the schema as a type and a typed `parse(text)`, with the module answering every check. See [Bun, compiled ahead of time](#bun-compiled-ahead-of-time). Needs ata-validator 1.61.0. |
| `verify` | `'ci'` | Hold every validator compiled away against the runtime on generated documents at the end of the build, and fail the build on a disagreement. `'ci'` runs it where the `CI` environment variable is set, `true` everywhere, a number that many documents a schema (50 for `true`), `false` never. Needs ata-validator 1.61.0; with an older one the default does nothing. |
| `report` | `true` | At the end of the build, log how many validators were compiled away and every `new Validator(...)` kept on the runtime, with file, line and reason. See [the report](#the-report-what-stayed-on-the-runtime-and-why). |
| `standardConsumers` | `[]` | Packages, besides the ones the build knows, whose imported functions take a validator and read only its `~standard`; a validator handed only to those takes the Standard-only wrapper. See below. |
| `ir` | `true` | Compile validators that are only called with `ata-validator/ir`, a smaller module with the same results; `false` keeps the larger one. See below. |
| `sharedErrors` | `'auto'` | Where a compiled validator's error detail comes from. A compact module carries its verdict and its schema and takes its errors from `ata-validator/error-runtime`, which the bundle holds once. `'auto'` scans the project's sources at build start (skipping `node_modules`, build output and test files), adds up what the replaceable calls a page loads together would save, and uses the runtime when the total pays for it; a file the scan did not see decides alone, which takes a schema of several hundred properties. Measured on projects of 1 to 40 SchemaStore schemas, no bundle came out bigger than with `false`, and 40 schemas went from 724 KB to 405 KB gzipped, on ata-validator 1.51.0. `true` writes every schema that allows it compact, and `false` never. The scan adds little to the build, measured in separate processes with esbuild: 84 to 85 ms for three validators, 681 to 715 ms for forty. Errors and verdicts are the same either way; a rejected document costs more, since its errors come from an interpreted walk. Needs ata-validator 1.50.0; with an older one every module stays self-contained, as before. |

## compileAway: keep `new Validator`, drop the compiler

Code written against the runtime API is compiled at build time without being
changed. This is on by default; `compileAway: false` turns it off.

```js
import { Validator } from 'ata-validator'

const check = new Validator({
  type: 'object',
  properties: { id: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1 } },
  required: ['id', 'name'],
})

export const handle = (body) => check.validate(body)
```

The plugin puts a compiled validator in place of the `new Validator(...)` call,
and once nothing else in the file uses the `ata-validator` import, the import
goes with it, so the runtime compiler is not in the bundle. For the three-schema
entry in `test/fixtures/compile-away`, one of them with defaults, a minified Vite
library build is 122.5 KB gzipped without it and 16.7 KB with it (gzip level 9), on
ata-validator 1.39.2. Across the 977 schemas of SchemaStore, 725 can be compiled
away this way.

Where the code only ever calls `isValidObject()` or `isValidJSON()`, the plugin
uses a smaller wrapper without the error machinery (needs ata-validator 1.40.0):
a small app that only asks for a boolean bundles to 2.6 KB gzipped, against 12.1 KB with
the full wrapper and 102.0 KB for the runtime, on 0.5.0 with ata-validator 1.40.0.

The replacement answers `validate()`, `isValidObject()`, `validateJSON()` and
`isValidJSON()` as a `Validator` with default options does: the same verdicts,
defaults filled in, `data` on success, and the same errors, enriched the same
way, since they come from the same code in ata-validator. ata-validator's own
tests hold that over every case of the official JSON Schema test suite and over
seeded schemas with defaults at every depth.

A call is replaced only when all of this is true, and left to the runtime
otherwise:

- `Validator` is a named import from `ata-validator`;
- the schema argument is an object literal, a top-level `const` bound to one,
  the default import of a relative `.json` file, a name imported from a
  relative JavaScript or TypeScript module (`import { Signup } from
  './schemas'`, `.js` standing for `.ts` as TypeScript writes it) that the
  module exports as such a value, directly, as `export default`, or through
  `export { ... } from`, or `defineSchema(...)` around one of those;
- the value is not changed after it is written: every use of the constant, in
  its own file and in the file with the call, is an argument of
  `new Validator(...)` or `ataResolver(...)`, possibly through
  `defineSchema(...)`, the `t` builder or an object or array literal that is
  itself such a constant, or an export. A write such as
  `schema.required = [...]`, a second name for it or a call that could change
  it keeps the call on the runtime, since the build reads the value as written
  (before 0.9.0 such a schema was compiled as written and could accept what the
  runtime rejects). The build reads those two files only: a third module that
  imports the schema and changes it is not seen, so a schema shared that way
  should not be changed at run time. The import of the schema module stays,
  so the bundler rebuilds when it changes; calls to the `t` builder from `ata-validator/t` whose arguments are
  such values are run at build time, since the builder returns plain JSON Schema,
  and are marked pure so a schema only the replaced call used leaves the bundle
  with the builder (`t.refine` and `t.recursive`, which take a function, stay on
  the runtime);
- there is no second argument, or it is `{ useDefaults: false }` (or
  `{ useDefaults: true }`), written as a literal or a top-level `const`; that
  one option needs ata-validator 1.37.0, and older versions keep such calls on
  the runtime;
- the result goes into a `const` that is not exported and is only used as
  `name.validate(...)`, `name.isValidObject(...)`, `name.validateJSON(...)` or
  `name.isValidJSON(...)`; the call may be wrapped in `withKeywords(...)` from
  `@ata-project/keywords`, which then registers its keywords on the compiled
  validator as it does on a `Validator` (needs ata-validator 1.40.0);
- ata-validator can compile the schema to the same results. It declines custom
  `errorMessage`s and shapes its code generator cannot express, which the
  runtime answers with its interpreted engine.

### react-hook-form: `ataResolver(schema)`

`ataResolver(schema)` from `@hookform/resolvers/ata-validator` is compiled away
the same way: the plugin writes `ataCompiledResolver(module)` in its place, and
the runtime leaves the bundle. A form written the usual way,

```tsx
import { useForm } from 'react-hook-form'
import { ataResolver } from '@hookform/resolvers/ata-validator'
import schema from './signup.json'

const form = useForm({ resolver: ataResolver(schema) })
```

adds 4.1 KB gzipped to react-hook-form for an eight-field signup form, against
135.4 KB without the plugin, in a minified esbuild build without code
splitting (ata-validator 1.57.0). The module fills defaults with its
`applyDefaults` and returns its errors in the runtime's order, so the
resolver's answer, values and field errors, is the one `ataResolver` gives.

The schema is read as above, and the call is replaced only when it passes no
validator options (or `undefined` or `{}` for them, with a literal
`{ raw: true }` or `{ raw: false }` for the resolver's own options), when the
installed `@hookform/resolvers` exports `ataCompiledResolver` from every file
its export map gives for `./ata-validator`, and when ata-validator writes
modules in the runtime's error order (1.57.0). Options such as `coerceTypes`
have no compiled form and keep the runtime.

`ataCompiledResolver` is not in a released `@hookform/resolvers` yet
([react-hook-form/resolvers#881](https://github.com/react-hook-form/resolvers/pull/881)).
Until it is, the call stays as written and the form keeps working as before;
once a release that has it is installed, the next build replaces the call
without any change to the app.

### rjsf: `<Form schema={schema} validator={validator} />`

A form from rjsf (`@rjsf/core` or a theme package) given the default
`validator` of `@rjsf/validator-ata` and a schema the build can read gets a
precompiled validator in its place, written by rjsf's own
`compileSchemaValidatorsCode` from the installed copy, so no build script is
needed:

```tsx
import Form from '@rjsf/core'
import validator from '@rjsf/validator-ata'
import schema from './signup.json'

export const Signup = () => <Form schema={schema} validator={validator} />
```

For a six-field signup form with React 19 and rjsf 6.11.0, the first load of a
minified esbuild build went from 207.8 KB to 159.5 KB gzipped (ata-validator
1.59.0). On two schemas with `$ref`, `oneOf`, `anyOf`,
`dependencies`, formats and defaults, 6000 generated documents gave the same
errors from both validators, in the same order, left the form's data the same,
and 400 server renders gave the same markup.

The element is rewritten when it has no spread attributes. The module is
written in the runtime's error order, which rjsf shows in its error list, and
fills defaults before the check, on a copy of the form's data, as rjsf's
runtime validator does. That needs ata-validator 1.59.0; with an older one the
form stays on the runtime validator. Importing `createPrecompiledValidator` leaves
the runtime validator out of the bundle from @rjsf/validator-ata 6.11.0. Once
no other use of `validator` is left, its import goes too.

### A schema from a TypeScript type: `schemaOf<User>()`

```ts
import { Validator, schemaOf } from 'ata-validator'

interface User {
  /** @minimum 1 */
  id: number
  /** @format email */
  email: string
  /** @minLength 1 */
  name: string
  role: 'admin' | 'user'
}

const user = new Validator(schemaOf<User>())
```

The plugin reads `User` with the TypeScript checker and writes its JSON
Schema in place of the call; the `new Validator(...)` then compiles away like
any static schema, and a bare `schemaOf<User>()` becomes the schema as a
value, for an OpenAPI document or a form. The JSDoc tags on the properties
carry what a type cannot say: `@format`, `@minimum`, `@maximum`, `@minLength`,
`@maxLength`, `@maxItems`, `@pattern`, `@asType integer`. A type is a closed
object (`additionalProperties: false`) unless `types: { additionalProperties:
true }` is passed. The type must be named (an interface or a type alias, in
the file or imported with `import type`); an inline type literal, a name the
checker does not find, or a call with a value argument stops the build with a
message naming the file and line. Without the plugin, `schemaOf()` throws at
run time: it has no run-time form, and a loud error beats an empty schema.

This needs `ts-json-schema-generator` and `typescript`, optional peer
dependencies of the plugin (`npm install -D ts-json-schema-generator
typescript`), and ata-validator 1.61.0 for the `schemaOf` export. The program is
the calling file and what it imports, with the compiler options of the
nearest `tsconfig.json` above it (or `types: { tsconfig }`), so a type is
always the one that file sees. Building that program took 120 to 270 ms per
file that calls `schemaOf`, once per build, and about 5 ms per type, on
TypeScript 5.9 and 7.0; the generator is loaded only when a file names the
call.

What this is not: a validator generated from a type for its own sake (typia
does that, for every runtime, without a schema in between). Here the type is
one way to write the JSON Schema, and the schema is what ata compiles,
publishes and validates with, everywhere ata runs.

### Handed to a router or a form library: `body: check`

A validator handed over as a value, an argument of a call directly or inside
an object or array literal, is compiled away too, where the installed
ata-validator's compiled wrapper carries Standard Schema (1.60.0). Elysia,
Hono's validator helpers, TanStack Form and tRPC read a validator through
`~standard`, and the compiled wrapper answers that as the runtime does:

```ts
import { Elysia } from 'elysia'
import { Validator } from 'ata-validator'

const signup = new Validator(schema)
new Elysia().post('/signup', ({ body }) => body, { body: signup })
```

For the Elysia app above, built with `Bun.build` on Bun 1.4.0, the bundle went
from 940 KB to 441 KB, the process from 26.3 to 18.0 ms and its first two
requests from 8.1 to 4.3 ms (medians of 21 runs); the `new Function` calls
left in the bundle are Elysia's own. The same route on Hono 4 with
`sValidator('json', signup)` from `@hono/standard-validator`: 573 KB to 74 KB,
17.3 to 9.1 ms, 5.3 to 1.5 ms, and no `new Function` left at all.

What the consumer does with the value is not read: it gets `validate()`,
`isValidObject()`, `validateJSON()`, `isValidJSON()` and `~standard`, and
calling anything else on the compiled wrapper throws a TypeError rather than
answering differently. A use in the file itself that reads a property,
assigns, returns or exports the validator keeps the runtime.

A consumer the build knows reads `~standard` and nothing else, and an issue is
a message and a path. A validator handed only to such a consumer, and never
called by the file's own code, takes the wrapper that carries `~standard`
alone (`ata-validator/compiled-standard`, ata-validator 1.61.3 on), on a module
that writes its errors as a message and a path in schema order: no error
pipeline in the bundle. The build knows a consumer by the root of the call the
validator is handed to: a function imported from `@hono/standard-validator`,
`hono-openapi`, the TanStack Form packages, `@orpc/server` or
`@orpc/contract`, `@trpc/server` or `elysia`, reached directly, through a
namespace import, or through a chain of members, calls and top-level constants
(`app.post(path, handler, { body: v })` with `const app = new Elysia()`;
`publicProcedure.input(v)` with `const t = initTRPC.create()` and `const
publicProcedure = t.procedure`). `standardConsumers: ['my-router']` adds
packages; a chain whose root is not on the list takes the wrapper with errors
as before.
Bundled with esbuild and gzipped, ata-validator 1.61.3 and the plugin's 0.12.0
against 0.11.1, one validator with an email field, a length, a range
and a default:

| app | framework alone | ata runtime | plugin 0.11.1 | plugin 0.12.0 |
|---|---|---|---|---|
| Hono 4.13 route, `sValidator`, for Workers | 7.7 KB | 66.7 KB | 21.0 KB | 12.2 KB |
| Elysia 1.4 route, `{ body }` hook | 106.8 KB | 258.4 KB | 120.1 KB | 110.1 KB |
| tRPC 11 procedure, `.input()` | 4.6 KB | 156.1 KB | 18.0 KB | 7.8 KB |

The issues are the runtime's, held issue for issue in
`test/compile-away-standard.test.js`, and the Hono and Elysia apps above answer
the same requests with the same responses from both builds. tRPC is the one
consumer where the runtime and a compiled wrapper differ, and they did before
this change: tRPC looks for a `parse()` method before `~standard`, finds the
runtime's, and reports an invalid input through the error that method throws;
a compiled wrapper has no `parse()`, so tRPC reads `~standard` and the error
carries `issues`, as it does for any Standard Schema.

Any other option (`new Validator(schema, { coerceTypes: true })`), a schema
built at run time, or an instance passed around in those other ways stays as
written.

### The report: what stayed on the runtime, and why

A kept `new Validator(...)` is the one thing that keeps the runtime compiler
in the bundle, so the build says which ones it kept and why, once, at the end:

```
[unplugin-ata] compileAway: 3 validators compiled at build time, 1 kept on the runtime
[unplugin-ata] kept on the runtime: src/routes/orders.ts:14 the schema is not a value the build can read: an object literal, a const bound to one, the default import of a relative .json file, or defineSchema(...) around one
```

The reasons are the rules above, one sentence each: the schema is not readable
at build time; the validator is used in a way the compiled wrapper cannot
answer (a property read, an export, a return, a reassignment); the options are
not a literal, or name one a module cannot reproduce; the call has more than
two arguments; ata-validator declines to compile the schema standalone. With
every call replaced the last line says so: `the runtime compiler is out of the
bundle`. `report: false` turns the lines off. Programmatically, `compileAway()`
returns `kept` as `[{ line, reason }]` beside `replaced`.

### Bun, compiled ahead of time

Bun's ahead-of-time compiler (`bun build --compile --aot`, `Bun.build({ compile:
{ aot: true } })`, an open pull request as of October 2026) runs code a
library hands to `new Function` through an interpreter. A module the plugin
writes is plain JavaScript and compiles with the program, so under that
compiler a replaced `new Validator(schema)` costs what it costs on the JIT.
Measured through the plugin with the compiler's pull request build of
2026-10-24, 1024 distinct documents, 10% of them invalid: a ten-item order 121
to 126 ns a document, where the same check through the runtime `Validator`
is 492 (generated code, interpreted) or 80 (its interpreted engine). Inside a
Hono request (`app.fetch` with a `Request`, no socket, the same 1024 bodies,
one `--aot` executable): a route that only parses the body 1,221 to 1,229 ns,
the same route with the ata check 1,337 to 1,391, with the ata check and the
error list in the 400 response 1,494 to 1,508, with zod 4,522 to 4,554.

In that build every module is written for Bun's compiler: a closed object's
keys are read once and compared with the declared list in order (65 to 53 ns
on that order over a module built on Node), and a rejection is answered with
ata's one-pass error function, 3.8x cheaper than the default collector and
20% larger gzipped, a size an executable does not pay for. A schema compiled
from the `schemas` globs also gets `x.schema.bun.ts` beside `x.schema.js`:
the schema as a TypeScript type, `validate` and `isValid` with the type on
them, and `parse(text)`, which declares the type where it parses and has the
module check the content. It is a type for the program, not a faster path:
on that order with the pull request build of 2026-10-25, `parse` 564 to 574
ns against 570 to 578 for a plain parse and the module. Under the
ahead-of-time build an import of the module is sent to the `.bun.ts`, and
the generated `.d.ts` declares `parse`. Every check is the module's.
`bunTarget: false` leaves the `.bun.ts` out. Without the plugin, a project
reaches the same file through an `"aot"` condition in its `package.json`
`imports`, which that compiler reads and nothing else does:

```json
{ "imports": { "#schemas/*": { "aot": "./schemas/*.bun.ts", "default": "./schemas/*.js" } } }
```

The pull request carried its own typed validator (`validate<T>` from
`bun:bundle`) until 2026-10-25, and the plugin wrote the schema's rules as a
type for it; that validator left the pull request to return as a change of
its own, and the plugin writes nothing for it now.

`verify` adds the proof: at the end of the build every validator the plugin
compiled away is held against a runtime `Validator` built from the same schema
on 50 documents made from it, half with one rule broken, and a disagreement
fails the build with the document. This is `ata verify` inside the bundler. It
runs by default where the `CI` environment variable is set and not on local
builds; `verify: true` runs it everywhere.

### `ir`, a smaller compiled validator

By default on ata-validator 1.63.1 and later (`ir: false` turns it off, `ir: true`
takes it on any ata-validator that has the entry), a validator the file only
calls (`validate()`, `isValidObject()`, never handed to other code) is compiled
by `ata-validator/ir` instead. The default waits for 1.63.1 because its module
writer is the one measured here: on 1.63.0 the modules were slower than the
compiled ones on 129 of 438 SchemaStore schemas by a fifth or more; from 1.63.1
on 51, and faster on 216 (warmed, against the schemas' own samples). Its module gives the same verdicts, the same
errors with every field in the same order, rich or plain, and fills the same
defaults; the helpers it needs come from `ata-validator/kernels`, imported once
however many validators a bundle has. Options other than `richErrors`,
`useDefaults` and `assertFormat`, and schemas the IR does not cover (custom
keywords or formats, `$vocabulary`, a `$ref` into another document; on
SchemaStore 48 of the 492 schemas that have sample documents), take the path
above.

Measured with esbuild (minified, gzip level 9) on form schemas with formats,
patterns and rich errors read:

| validators in the bundle | `ir: false` | `ir`, `table: false` | `ir`, `table: 'auto'` (default) |
|---|---|---|---|
| 1 | 11.0 KB | 4.3 KB | 4.3 KB (modules) |
| 3 | 12.7 KB | 5.6 KB | 5.5 KB (plans) |
| 10 | 17.6 KB | 8.4 KB | 5.8 KB (plans) |

On the 654 SchemaStore schemas both paths compile away, one validator per
bundle, the default bundle is 0.52 of the `ir: false` one at the median (0.38
to 0.67 from the 10th to the 90th percentile) and larger on none, 14.8 MB to
8.3 MB in all.

Each module carries functions that answer a valid document without gathering
errors, which `validate()` runs first. They cost about 6% of the module and
made `validate()` on valid documents about 20% faster at the median across
SchemaStore. Where the IR declines a schema's default fill, the module
carries ata-validator's generated one rather than the shared interpreted
pass. On the one-form bundle the two paths are within 1% of each other on
valid and invalid documents and on `isValidObject()`.

Across SchemaStore's sample documents, each call on a freshly copied
document, all schemas in one process: `validate()` with the errors of an
invalid document read takes 0.64 of the `ir: false` time at the median, and
is faster on 114 of 116 schemas and slower on none. `isValidObject()` on a
valid document takes 1.03 of it at the median (0.63 to 1.94 from the 10th to
the 90th percentile); the slowest, sil-kit's participant configuration,
measured 6.3 times there and 1.9 times in a process of its own. Loaded fresh
in a new process, bundled, with its first ten calls, the default module took
0.49 of the time at the median and was faster on all 48 schemas sampled,
mostly because there is less to load. The form bundles were run on 42000
generated documents and the SchemaStore modules on their sample and mutated
documents; every error list matched the runtime's, field for field and in
order.
Needs ata-validator 1.63.0 or later; with an older one the option does
nothing.

### `table`, many forms as data

A written module is fast and costs about 400 bytes gzipped a form. With
`table: 'auto'` (the default) the build also writes each validator as a plan
for one interpreter, compares the two for the files a page loads together,
and takes the plans where that comparison says the page comes out smaller; a
schema the plans do not cover keeps its module. The threshold was set on
Vite + React builds of 1 to 10 forms, plain and rich, with and without format
checks, where it never took the plans for the larger bundle. The verdicts,
errors and defaults are the same either way, and the build log says how many
files took plans.

What loads together is read from the project's own imports: each entry of
the build and each target of a dynamic `import()` starts a load, and the
files it imports statically belong to it. A file takes plans only if every
load that holds it is smaller for them. Up to 0.16.0 the comparison was made
once over every source under the root, which put the interpreter on each
page of a site with one form a page. Measured on such sites, first load
gzipped a page: four pages built with esbuild and code splitting, 4.4 KB
before and 2.7 to 3.9 KB now; a page that only asks `isValidObject()`,
bundled alone, 4.1 KB before and 0.65 now; six forms with an email field
behind three entries and three dynamic imports in Vite, 4.9 to 5.1 KB before
and 3.9 to 4.8 now. An application that loads its forms together takes plans
as before.

Imports are resolved through relative paths, Vite's `resolve.alias`, the
`paths` of the root's `tsconfig.json` or `jsconfig.json`, and the `@/`, `~/`
and `$lib` conventions. An import the build cannot follow leaves its target
in a load of its own, which keeps modules there. The entries are read from
Vite, Rollup, Rolldown, esbuild, webpack and Rspack; where an entry is not a
file of the project, as under Next.js, every file nothing imports counts as
one, a story or a script beside the application included, and `table: true`
takes plans regardless. `sharedErrors: 'auto'` is decided over the same
loads.

In a Vite + React application with ten six-field forms reading plain errors,
the validators add 2.02 KB gzipped to the first load, against 5.35 KB as
modules; with email and uri fields among them, 2.70 KB against 8.24. Plans
check email and uri with regular expressions that give the scanners' answers
on every string tested, in a third of the bytes. On a single form the build
keeps the written module, which there is the smaller (1.41 KB). A plan is
slower per call than a module (445 against 22 ns on a valid order form), so
`table: false` keeps modules everywhere, and `table: true` takes plans
wherever they cover the schema.

## How it works

Output goes to disk, not to virtual modules. That is what makes the plugin
identical across bundlers and what lets TypeScript see the generated
declarations without any bundler-specific type plumbing.

Schemas compile on build start. On a schema change, Vite recompiles through
its HMR hook and Webpack, Rspack, Rollup and Rolldown through `watchChange`.
esbuild has no watch hook, so under `esbuild --watch` a schema edit alone does
not trigger a rebuild; the next build start compiles it.

`.ts` schemas load through [jiti](https://github.com/unjs/jiti). A schema
module exports the schema as `default` or as a named `schema`.

A schema the standalone compiler cannot represent is reported with a warning
and skipped; the ata-validator runtime API still validates it.

## Programmatic use

```js
import { compile } from '@ata-project/unplugin'

const { files, results } = await compile({ schemas: 'schemas/**/*.json', root: process.cwd() })
```

With the `zod` or `from` option, `compile()` writes each `<module>.validators.mjs`
already compiled: every export is its schema written out as checks, and the
file imports only the small helpers those checks use, never the validator
runtime. A script has no bundler behind it to compile the file later, and a
file left as `new Validator(schema)` is small only in a build that runs this
plugin. Imported by a build that does not, each validator brings the runtime
compiler with it: on a page that uses one validator, bundled with esbuild and
no plugin, 3.9 KB gzipped compiled against 142.8 KB as `new Validator`
(ata-validator 1.63.1). A server can import the same file.

Before `compile()` writes a validators file it holds it against the library
the schemas are written in. For each export it makes documents from the schema
(valid ones, ones with one rule broken, the two sides of every bound; 50 an
export, or `verify: <number>`), gives each to zod's `safeParse` (valibot's
`safeParse`, TypeBox's `Value.Check`) and to the written validator, and
compares the two verdicts. A difference throws with the document, and the file
is not written. `result.zod.verified` holds the counts. An export whose
refinements were dropped with `dropRefinements` is not compared. The documents
come from the schema, so the check sees what the schema's own rules reach; it
is not a proof. On 17 schemas of 41 fields it added about 30 ms to a 140 ms
compile. `verify: false` skips it. It needs ata-validator 1.61.0.

`compile({ ..., check: true })` writes nothing and returns in `stale` the
files a compile would write or change, for a CI step that fails when the
generated files were not regenerated:

```js
const { stale } = await compile({ zod: ['src/events/*.schema.ts'], check: true })
if (stale.length) { console.error('run the compile script:', stale); process.exit(1) }
```

Where there are many validators, `compile()` writes them as plans for one small
interpreter instead of as checks written out one by one, when that makes the
smaller bundle: it weighs all its files together, as the plugin does for an
application, and chooses plans when they save more than the interpreter costs.
Seven flat event schemas in one entry, bundled with esbuild and no plugin, come
to 2.8 KB gzipped as plans (12 KB before compression) against 10.5 KB as
written checks (139 KB). A plan is slower to run than written checks: on an
event of 44 optional fields a valid document takes about 1.0 µs against 0.6,
and a rejected one with its errors read 1.4 µs against 0.1. `table: false`
keeps written checks, `table: true` takes plans whatever the sizes; the result
of `compile()` says which was chosen (`table`).

`compiled: false` keeps the `new Validator(schema)` form, for a project whose
bundler runs the plugin and should make the choices it makes for a whole
application (shared errors, table plans). The plugin itself, inside a bundler,
writes that form and compiles it in the same build. A file the build cannot
compile whole is written in that form too, with a warning that says why.

## Tests

`npm test` compiles the same entry with Vite, Webpack, Rollup, Rolldown,
esbuild and Rspack, imports each bundle and runs the validator it contains. The
compileAway tests build a second entry with all six, check that neither the
runtime compiler nor the interpreter is in the output, and compare every answer
with `new Validator`; the decline rules are tested on their own.
The Bun target's end-to-end tests build an executable with `Bun.build({
compile: { aot: true } })` and run only when `BUN_AOT` names a Bun that has
`--aot`; the transform's output is checked without it.

## Package name

The package is `@ata-project/unplugin`; the plugin registers itself in the
bundler as `unplugin-ata`, which is the name in log lines and in
`plugin.name`. The unscoped name is not available on npm.

## Relation to ata-vite

`ata-vite` is this plugin's Vite entry with the old name. It keeps working;
new projects can use either.

## License

MIT
