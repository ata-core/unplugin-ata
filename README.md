# @ata-project/unplugin

Compiles JSON Schema files into self-contained [ata-validator](https://ata-validator.com) modules at build time, with TypeScript declarations, in Vite, Webpack, Rollup, Rolldown, esbuild, Rspack and Bun. One plugin, built on [unplugin](https://github.com/unjs/unplugin).

The generated module imports nothing. A small schema compiles to about 1.3 KB gzipped and a ten-field one to about 2.6 KB, full error detail included, on ata-validator 1.36.0; the module exports `validate`, `isValid` and the inferred type, and runs anywhere plain JavaScript runs.

Schemas can be authored as `.json`, `.js` or `.ts`.

It also compiles away `new Validator(schema)` in your own code wherever the schema
is known at build time and the result is the same, so the runtime compiler stays
out of the bundle: for the test entry, 122.5 KB gzipped becomes 16.7 KB. See
[compileAway](#compileaway-keep-new-validator-drop-the-compiler).

## Install

```bash
npm install --save-dev @ata-project/unplugin ata-validator
```

`ata-validator` is a peer dependency and is only used at build time.

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

Next.js uses Webpack, so the Webpack entry goes into `next.config.js`:

```js
const ata = require('@ata-project/unplugin/webpack')

module.exports = {
  webpack(config) {
    config.plugins.push(ata({ schemas: 'schemas/**/*.schema.json' }))
    return config
  },
}
```

Turbopack has no plugin interface this could attach to. Run the compile as a
step before the build instead: `ata build 'schemas/**/*.schema.json'` from
ata-validator's CLI, or the `compile()` function below in a script.

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
| `outDir` | next to each schema | Directory for generated files, mirroring the source layout. |
| `format` | `'esm'` | `'esm'` or `'cjs'`. |
| `abortEarly` | `false` | Emit the smaller validator that stops at the first failure. |
| `types` | `true` | Emit a `.d.ts` next to each validator. |
| `nameFromFile` | file name in PascalCase | Type name for schemas without `title` or `$id`. |
| `root` | from the bundler | Where the globs resolve from. Vite's root, Webpack's and Rspack's `context`, esbuild's `absWorkingDir` and Bun.build's `root` are read; Rollup and Rolldown need it passed. |
| `alias` | Vite's `resolve.alias` | Import aliases inside `.ts` schema files. tsconfig `paths` work without configuration. |
| `compileAway` | `true` | Replace `new Validator(schema)` in your code with a validator compiled at build time, where that gives the same results. See below. Needs ata-validator 1.36.0; with an older version the runtime stays, and a warning is printed only if you set the option yourself. |
| `report` | `true` | At the end of the build, log how many validators were compiled away and every `new Validator(...)` kept on the runtime, with file, line and reason. See [the report](#the-report-what-stayed-on-the-runtime-and-why). |
| `sharedErrors` | `'auto'` | Where a compiled validator's error detail comes from. A compact module carries its verdict and its schema and takes its errors from `ata-validator/error-runtime`, which the bundle holds once. `'auto'` scans the project's sources at build start (skipping `node_modules`, build output and test files), adds up what every replaceable call would save, and uses the runtime when the total pays for it; a file the scan did not see decides alone, which takes a schema of several hundred properties. Measured on projects of 1 to 40 SchemaStore schemas, no bundle came out bigger than with `false`, and 40 schemas went from 724 KB to 405 KB gzipped, on ata-validator 1.51.0. `true` writes every schema that allows it compact, and `false` never. The scan adds little to the build, measured in separate processes with esbuild: 84 to 85 ms for three validators, 681 to 715 ms for forty. Errors and verdicts are the same either way; a rejected document costs more, since its errors come from an interpreted walk. Needs ata-validator 1.50.0; with an older one every module stays self-contained, as before. |

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

## Tests

`npm test` compiles the same entry with Vite, Webpack, Rollup, Rolldown,
esbuild and Rspack, imports each bundle and runs the validator it contains. The
compileAway tests build a second entry with all six, check that neither the
runtime compiler nor the interpreter is in the output, and compare every answer
with `new Validator`; the decline rules are tested on their own.

## Package name

The package is `@ata-project/unplugin`; the plugin registers itself in the
bundler as `unplugin-ata`, which is the name in log lines and in
`plugin.name`. The unscoped name is not available on npm.

## Relation to ata-vite

`ata-vite` is this plugin's Vite entry with the old name. It keeps working;
new projects can use either.

## License

MIT
