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

export const unpluginFactory = (userOptions = {}) => {
  const session = createSession(userOptions)

  return {
    name: 'unplugin-ata',
    enforce: 'pre',

    async buildStart() {
      const { files, results } = await session.compileAll()
      const changed = results.filter((r) => r.changed).length
      session.logger?.info?.(`[unplugin-ata] compiled ${files.length} schema(s), ${changed} file(s) written`)
    },

    async watchChange(id) {
      await session.compileIfMatching(id)
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
