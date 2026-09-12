# unplugin-ata

Compiles JSON Schema files into self-contained [ata-validator](https://ata-validator.com) modules at build time, with TypeScript declarations, in Vite, Webpack, Rollup, Rolldown, esbuild and Rspack. One plugin, built on [unplugin](https://github.com/unjs/unplugin).

The generated module imports nothing. A typical schema compiles to about 1 KB gzipped, exports `validate`, `isValid` and the inferred type, and runs anywhere plain JavaScript runs.

Schemas can be authored as `.json`, `.js` or `.ts`.

## Install

```bash
npm install --save-dev unplugin-ata ata-validator
```

`ata-validator` is a peer dependency and is only used at build time.

## Setup

Vite:

```ts
// vite.config.ts
import ata from 'unplugin-ata/vite'

export default {
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
}
```

Webpack:

```js
// webpack.config.js
const ata = require('unplugin-ata/webpack')

module.exports = {
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
}
```

Rollup:

```js
// rollup.config.js
import ata from 'unplugin-ata/rollup'

export default {
  // Rollup has no project root; tell the plugin where the globs start.
  plugins: [ata({ schemas: 'src/**/*.schema.json', root: process.cwd() })],
}
```

esbuild:

```js
import { build } from 'esbuild'
import ata from 'unplugin-ata/esbuild'

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
})
```

Rspack:

```js
// rspack.config.js
const ata = require('unplugin-ata/rspack')

module.exports = {
  plugins: [ata({ schemas: 'src/**/*.schema.json' })],
}
```

Rolldown:

```js
// rolldown.config.js
import ata from 'unplugin-ata/rolldown'

export default {
  plugins: [ata({ schemas: 'src/**/*.schema.json', root: process.cwd() })],
}
```

Next.js uses Webpack, so the Webpack entry goes into `next.config.js`:

```js
const ata = require('unplugin-ata/webpack')

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
import { compile } from 'unplugin-ata'

const { files, results } = await compile({ schemas: 'schemas/**/*.json', root: process.cwd() })
```

## Tests

`npm test` compiles the same entry with Vite, Webpack, Rollup, Rolldown,
esbuild and Rspack, imports each bundle and runs the validator it contains.

## Relation to ata-vite

`ata-vite` is this plugin's Vite entry with the old name. It keeps working;
new projects can use either.

## License

MIT
