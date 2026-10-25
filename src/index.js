// unplugin-ata: build-time schema compilation for Vite, Webpack, Rollup,
// Rolldown, esbuild and Rspack, through unplugin. The work happens in
// src/core.js; this file maps it onto the hooks every bundler shares
// (buildStart, watchChange) and the two Vite has on top (configResolved for
// the root, the logger and resolve.alias; handleHotUpdate for dev).
//
// esbuild has no watch hook in unplugin, so under `esbuild --watch` schemas
// compile on each build start but a schema edit alone does not trigger one.

import path from 'node:path'
import { createUnplugin } from 'unplugin'
import { createSession, normalizeAlias, compile, __internal } from './core.js'
import fs from 'node:fs'
import { compileAway, sharedErrorsPay, clearSizes } from './compile-away.js'

const SOURCE = /\.[cm]?[jt]sx?$/

// Source files the application may import, for the sharedErrors scan: what
// the transform would see, without node_modules, build output, tests and
// dot-directories. Only files that mention ata-validator are kept.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.cache'])
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
function scanSources(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 12) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test' && e.name !== 'tests') walk(p, depth + 1); continue }
      if (!e.isFile() || !SOURCE.test(e.name) || TEST_FILE.test(e.name)) continue
      let code
      try { if (fs.statSync(p).size > 1 << 20) continue; code = fs.readFileSync(p, 'utf8') } catch { continue }
      if (code.includes('ata-validator')) out.push([code, p])
    }
  }
  walk(root, 0)
  return out
}

// The scan and the transform compile the same schemas: one compile each.
function cachedApi(session, api) {
  if (session.cachedApi && session.cachedApiFor === api) return session.cachedApi
  const memo = new Map()
  const compiledModuleFor = (schema, opts) => {
    const key = JSON.stringify(schema) + '\u0000' + JSON.stringify(opts || {})
    if (!memo.has(key)) memo.set(key, api.compiledModuleFor(schema, opts))
    return memo.get(key)
  }
  session.cachedApi = { ...api, compiledModuleFor }
  session.cachedApiFor = api
  return session.cachedApi
}

export const unpluginFactory = (userOptions = {}) => {
  const session = createSession(userOptions)

  return {
    name: 'unplugin-ata',
    enforce: 'pre',

    async buildStart() {
      const { files, results } = await session.compileAll()
      const changed = results.filter((r) => r.changed).length
      session.logger?.info?.(`[unplugin-ata] compiled ${files.length} schema(s), ${changed} file(s) written`)
      // sharedErrors 'auto' decides for the whole application, not file by
      // file: the sources are scanned once here, and the runtime is used when
      // every replaceable call together saves more than it costs.
      session.sharedDecision = undefined
      clearSizes()
      session.scanned = null
      if (userOptions.compileAway !== false && (userOptions.sharedErrors === undefined || userOptions.sharedErrors === 'auto')) {
        const api = await session.api()
        if (api.compiledModuleFor && api.compiledSharedErrors) {
          const sources = scanSources(session.root || process.cwd())
          session.scanned = new Set(sources.map(([, id]) => path.resolve(id)))
          const { pays, saving, calls } = await sharedErrorsPay(sources, cachedApi(session, api))
          // When the whole application does not pay for the runtime, no single
          // call does either: the transform skips the compact attempt. A file
          // the scan did not see (outside the root) decides alone, by the
          // per-module rule, which never makes a bundle bigger either.
          session.sharedDecision = pays ? 'smaller' : false
          if (calls > 0) session.logger?.info?.(`[unplugin-ata] ${calls} validator(s) can share one error runtime, saving ${saving} bytes gzipped against its cost: ${pays ? 'shared' : 'kept self-contained'}`)
        }
      }
    },

    async watchChange(id) {
      await session.compileIfMatching(id)
    },

    // compileAway: `new Validator(schema)` with a schema the build can read
    // becomes a validator compiled here, and the runtime compiler leaves the
    // bundle. See src/compile-away.js for what is replaced and what is not.
    // On unless the caller turned it off. It replaces a call only where the
    // compiled validator answers exactly as the runtime would, so being on by
    // default can cost a saving but not change a result.
    transformInclude(id) {
      if (userOptions.compileAway === false) return false
      const file = id.split('?')[0]
      return SOURCE.test(file) && !file.split(/[\\/]/).includes('node_modules')
    },

    async transform(code, id) {
      if (!code.includes('ata-validator') && !code.includes('@rjsf/validator-ata')) return null
      const api = await session.api()
      if (!api.compiledModuleFor) {
        // Only a caller who asked for it hears that it could not happen; on
        // by default, an older ata-validator just keeps the runtime.
        if (userOptions.compileAway === true && !session.warnedCompileAway) {
          session.warnedCompileAway = true
          session.logger?.warn?.('[unplugin-ata] compileAway needs ata-validator 1.36.0 or later; nothing was replaced')
        }
        return null
      }
      const file = id.split('?')[0]
      const scanned = session.sharedDecision !== undefined && session.scanned && session.scanned.has(path.resolve(file))
      const kept = []
      const out = compileAway(code, file, cachedApi(session, api), { sharedErrors: scanned ? session.sharedDecision : userOptions.sharedErrors , kept })
      if (out || kept.length) session.report.set(path.resolve(file), { replaced: out ? out.replaced : 0, kept })
      return out ? { code: out.code, map: out.map } : null
    },

    // The report: how many validators the build compiled away, and every
    // `new Validator(...)` it had to keep on the runtime, with the file, the
    // line and the reason. A kept call is the one thing that puts the runtime
    // compiler back in the bundle, so it is said out loud, once per build.
    // `report: false` turns it off.
    buildEnd() {
      if (userOptions.report === false || userOptions.compileAway === false) return
      let replaced = 0
      const kept = []
      for (const [file, r] of session.report) {
        replaced += r.replaced
        for (const k of r.kept) kept.push(`${path.relative(session.root || process.cwd(), file)}:${k.line ?? '?'} ${k.reason}`)
      }
      session.report.clear()
      if (replaced === 0 && kept.length === 0) return
      session.logger?.info?.(`[unplugin-ata] compileAway: ${replaced} validator${replaced === 1 ? '' : 's'} compiled at build time${kept.length ? `, ${kept.length} kept on the runtime` : ', the runtime compiler is out of the bundle'}`)
      for (const line of kept) session.logger?.warn?.(`[unplugin-ata] kept on the runtime: ${line}`)
    },

    // Where `schemas` globs resolve from. Vite says so in configResolved,
    // Webpack and Rspack in compiler.context, esbuild in absWorkingDir; Rollup
    // has no notion of a project root, so it takes the `root` option or the
    // working directory. `root` given explicitly wins everywhere.
    webpack(compiler) {
      if (!userOptions.root && compiler.context) session.root = compiler.context
      session.logger = compiler.getInfrastructureLogger?.('unplugin-ata') ?? null
    },

    rspack(compiler) {
      if (!userOptions.root && compiler.context) session.root = compiler.context
      session.logger = compiler.getInfrastructureLogger?.('unplugin-ata') ?? null
    },

    esbuild: {
      setup(build) {
        const cwd = build.initialOptions && build.initialOptions.absWorkingDir
        if (!userOptions.root && cwd) session.root = cwd
      },
    },

    // Bun.build: the `root` of its config when given, else the working
    // directory. The same plugin runs under `bun build --compile` through
    // Bun.build({ compile }), where the compiled validators replace the
    // runtime in the executable.
    bun: {
      setup(build) {
        const root = build.config && build.config.root
        if (!userOptions.root && root) session.root = root
      },
    },

    vite: {
      configResolved(config) {
        if (!userOptions.root) session.root = config.root || session.root
        session.logger = config.logger
        // Carry Vite's resolve.alias into the .ts loader so aliased imports in
        // schema files resolve. tsconfig `paths` are handled by jiti directly.
        session.options.alias = normalizeAlias(config.resolve && config.resolve.alias)
      },

      async handleHotUpdate(ctx) {
        const result = await session.compileIfMatching(ctx.file)
        if (result && result.changed) {
          session.logger?.info?.(`[unplugin-ata] recompiled ${path.relative(session.root, ctx.file)}`)
        }
        return undefined
      },
    },
  }
}

const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory)

export default unplugin
export { compile, __internal }
