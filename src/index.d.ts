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
}

export interface CompileResult {
  files: string[]
  results: Array<{ changed: boolean; typeName: string | null; paths: { dir: string; mjs: string; dts: string } | null }>
}

/** Compile once, outside any bundler. */
export function compile(options?: Options): Promise<CompileResult>

declare const unplugin: UnpluginInstance<Options | undefined, boolean>
export default unplugin
