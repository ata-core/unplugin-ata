import type { UnpluginInstance } from 'unplugin'

export interface Options {
  /** Glob or globs, relative to the project root. Default: `**​/*.schema.json`. */
  schemas?: string | string[]
  /** Where generated files go. Default: next to each schema. */
  outDir?: string | null
  /** Module format of the generated validator. Default: `'esm'`. */
  format?: 'esm' | 'cjs'
  /** Emit the smaller abort-early validator. Default: `false`. */
  abortEarly?: boolean
  /** Emit a `.d.ts` next to each validator. Default: `true`. */
  types?: boolean
  /** Type name for schemas without `title` or `$id`. */
  nameFromFile?: (file: string) => string
  /**
   * Project root the globs resolve from. Read from the bundler when it has
   * one (Vite's root, Webpack's and Rspack's `context`, esbuild's
   * `absWorkingDir`); Rollup has none, so pass it there.
   */
  root?: string
  /** Aliases for imports inside `.ts` schema files. Vite's `resolve.alias` is picked up. */
  alias?: Record<string, string>
  /**
   * Replace `new Validator(schema)` with a validator compiled at build time
   * wherever the schema can be read without running code and the instance is
   * only used through validate(), isValidObject(), validateJSON() and
   * isValidJSON(), so the runtime compiler stays out of the bundle. Results are
   * the ones the runtime gives. Needs ata-validator 1.35.0 or later.
   * Default: `true`; `false` turns it off.
   */
  compileAway?: boolean
  /**
   * At the end of the build, log how many validators compileAway compiled at
   * build time and every `new Validator(...)` it kept on the runtime, with the
   * file, the line and the reason. Default: `true`; `false` turns it off.
   */
  report?: boolean
  /**
   * Packages, besides the ones the plugin knows, whose imported functions take
   * a validator and read only its `~standard`. A validator handed only to those
   * takes the wrapper that carries `~standard` alone.
   */
  standardConsumers?: string[]
  /**
   * Compile a validator that is only called (`validate()`, `isValidObject()`)
   * with ata-validator/ir instead: same verdicts, errors and defaults, a
   * smaller module, and helpers shared across a bundle through
   * ata-validator/kernels. A schema or option the IR does not cover keeps the
   * existing path. Needs ata-validator 1.63.0 or later;
   * with an older one it does nothing. `false` keeps the existing path.
   * @default true
   */
  ir?: boolean
  /**
   * Validators the IR compiles go out as plans for one shared table
   * interpreter (ata-validator/kernels) instead of code, where that makes the
   * bundle smaller: with 'auto' (the default) the build compares the two for
   * the whole application and takes plans only when they are smaller, which
   * on form schemas is from three or four forms on. `true` always, `false`
   * never. Verdicts and errors are the same either way.
   */
  table?: boolean | 'auto'
  /**
   * OpenAPI documents (3.0 or 3.1; JSON, or YAML with the `yaml` package) to
   * write request body validators for: `openapi.json` gives
   * `openapi.validators.mjs` and `.d.mts` beside it, one `<operation>Body`
   * validator per operation with a JSON body. The module is plain source a
   * server can import as it is; a page's build compiles each validator.
   */
  openapi?: string | { file: string; validatorOptions?: { richErrors?: boolean; useDefaults?: boolean; assertFormat?: boolean } } | Array<string | { file: string; validatorOptions?: { richErrors?: boolean; useDefaults?: boolean; assertFormat?: boolean } }>
  /**
   * Modules exporting zod 4 schemas, by glob: `'src/events/*.ts'` writes
   * `src/events/widget.validators.mjs` and `.d.mts` beside each, one
   * `{ validate, isValidObject }` per exported schema, converted with
   * `z.toJSONSchema(schema, { io: 'input' })` so an unknown key passes as it
   * passes `z.object`. A schema with a refine, transform, pipe or preprocess
   * fails the build by export and path, since the conversion would drop it
   * silently; `dropRefinements: true` takes them out knowingly.
   */
  zod?: string | string[] | { files: string | string[]; dropRefinements?: boolean; validatorOptions?: { richErrors?: boolean; useDefaults?: boolean } } | Array<string | { files: string | string[]; dropRefinements?: boolean; validatorOptions?: { richErrors?: boolean; useDefaults?: boolean } }>
  /**
   * Like `zod`, for modules exporting zod, valibot or TypeBox schemas, each
   * export by its own library: `'src/schemas/*.ts'`. valibot converts with
   * `@valibot/to-json-schema` (input mode), a TypeBox schema is JSON Schema as
   * written; a check, transform, registered format, custom kind or a
   * reference out of the document that a page cannot carry fails the build
   * by export and path.
   */
  from?: string | string[] | { files: string | string[]; dropRefinements?: boolean; validatorOptions?: { richErrors?: boolean; useDefaults?: boolean } } | Array<string | { files: string | string[]; dropRefinements?: boolean; validatorOptions?: { richErrors?: boolean; useDefaults?: boolean } }>
  /**
   * Under `Bun.build({ compile: { aot: true } })`, write a `.bun.ts` beside
   * each module compiled from the `schemas` globs: the schema as a TypeScript
   * type, the module's functions with the type on them, and a typed
   * `parse(text)`; an import of the module goes there in that build. Every
   * check is the module's. Taken from the build's `compile.aot` by default;
   * `true` writes it without the flag, `false` never. Needs ata-validator 1.61.0.
   */
  bunTarget?: boolean
  /**
   * At the end of the build, hold every validator compiled away against the
   * runtime on documents made from its schema (as `ata verify` does), and fail
   * the build on a disagreement. `'ci'` (the default) runs it where the CI
   * environment variable is set; `true` everywhere, a number that many
   * documents a schema (50 for `true`), `false` never. Needs ata-validator
   * 1.61.0; with an older one the default does nothing.
   */
  verify?: boolean | number | 'ci'
  /**
   * Where a replaced validator's error detail comes from. `'auto'` (default)
   * scans the project's sources at build start and writes modules compact
   * (their verdict and schema, with errors from `ata-validator/error-runtime`,
   * held once by the bundle) when all of them together save more than the
   * runtime adds; `true` writes every module that can be compact; `false`
   * never.
   * Needs ata-validator 1.50.0.
   */
  sharedErrors?: 'auto' | boolean
}

export interface CompileResult {
  files: string[]
  results: Array<{ changed: boolean; typeName: string | null; paths: { dir: string; mjs: string; dts: string } | null }>
}

/** Compile once, outside any bundler. */
export function compile(options?: Options): Promise<CompileResult>

declare const unplugin: UnpluginInstance<Options | undefined, boolean>
export default unplugin
