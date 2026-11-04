import type { Options } from './index.js'

/** Compiles validators at build time under webpack and under Turbopack. */
declare function withAta<T extends object> (nextConfig?: T, options?: Options): T
export default withAta
