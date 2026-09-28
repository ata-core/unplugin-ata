# @ata-project/unplugin

Compiles JSON Schema files into self-contained [ata-validator](https://ata-validator.com) modules at build time, with TypeScript declarations, in Vite, Webpack, Rollup, Rolldown, esbuild and Rspack. One plugin, built on [unplugin](https://github.com/unjs/unplugin).

The generated module imports nothing. A small schema compiles to about 1.3 KB gzipped and a ten-field one to about 2.6 KB, full error detail included, on ata-validator 1.36.0; the module exports `validate`, `isValid` and the inferred type, and runs anywhere plain JavaScript runs.

Schemas can be authored as `.json`, `.js` or `.ts`.

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
| `root` | from the bundler | Where the globs resolve from. Vite's root, Webpack's and Rspack's `context` and esbuild's `absWorkingDir` are read; Rollup and Rolldown need it passed. |
| `alias` | Vite's `resolve.alias` | Import aliases inside `.ts` schema files. tsconfig `paths` work without configuration. |
| `compileAway` | `false` | Replace `new Validator(schema)` in your code with a validator compiled at build time, where that gives the same results. See below. Needs ata-validator 1.36.0. |

## compileAway: keep `new Validator`, drop the compiler

With `compileAway: true`, code written against the runtime API is compiled at
build time without being changed:

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
library build is 115.7 KB gzipped without it and 15.5 KB with it, on
ata-validator 1.36.0. Across the 977 schemas of SchemaStore, 725 can be compiled
away this way.

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
  the default import of a relative `.json` file, or `defineSchema(...)` around
  one of those;
- there is no second argument, or it is `{ useDefaults: false }` (or
  `{ useDefaults: true }`), written as a literal or a top-level `const`; that
  one option needs ata-validator 1.37.0, and older versions keep such calls on
  the runtime;
- the result goes into a `const` that is not exported and is only used as
  `name.validate(...)`, `name.isValidObject(...)`, `name.validateJSON(...)` or
  `name.isValidJSON(...)`;
- ata-validator can compile the schema to the same results. It declines custom
  `errorMessage`s and shapes its code generator cannot express, which the
  runtime answers with its interpreted engine.

Any other option (`new Validator(schema, { coerceTypes: true })`), a schema
built at run time, or an instance passed around stays as written.

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
