// withAta(nextConfig, options): compiles validators at build time under
// either bundler Next.js runs, the plugin under webpack (`next build
// --webpack`) and the loader in ./turbopack.cjs under Turbopack, the default
// since Next.js 16. The rest of the config is kept: a webpack function of its
// own still runs, and Turbopack rules of its own stay.
import { createRequire } from 'node:module'
import unplugin from './index.js'

const require = createRequire(import.meta.url)
const SOURCES = '*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'

export default function withAta (nextConfig = {}, options = {}) {
  const loader = { loader: require.resolve('./turbopack.cjs'), options }
  const turbopack = nextConfig.turbopack || {}
  const rules = { ...(turbopack.rules || {}) }
  const own = rules[SOURCES]
  if (own !== undefined) throw new Error(`[unplugin-ata] withAta: turbopack.rules already has '${SOURCES}'; add ${loader.loader} to its loaders yourself`)
  rules[SOURCES] = { loaders: [loader] }
  return {
    ...nextConfig,
    turbopack: { ...turbopack, rules },
    webpack (config, ctx) {
      config.plugins.unshift(unplugin.webpack(options))
      return typeof nextConfig.webpack === 'function' ? nextConfig.webpack(config, ctx) : config
    },
  }
}
