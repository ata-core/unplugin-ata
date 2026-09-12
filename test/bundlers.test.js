// Every bundler builds the same entry, which imports a validator the plugin
// generates at build start. The built output is imported and run, so this
// proves the generated module is standalone and the plugin ran early enough
// for the bundler to resolve the import.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import unplugin from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'fixtures', 'bundlers')
const entry = path.join(root, 'entry.mjs')
const pluginOptions = { schemas: 'schemas/*.schema.json' }

async function cleanGenerated() {
  const dir = path.join(root, 'schemas')
  for (const f of await fs.readdir(dir)) {
    if (/\.schema\.(js|d\.ts)$/.test(f)) await fs.unlink(path.join(dir, f))
  }
}

async function outDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `unplugin-ata-${name}-`))
}

async function check(file) {
  const src = await fs.readFile(file, 'utf8')
  assert.doesNotMatch(src, /from\s+['"]ata-validator|require\(['"]ata-validator/, 'the built output must not import ata-validator')
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`)
  assert.equal(mod.isValid({ id: 1, name: 'a' }), true)
  assert.equal(mod.isValid({ id: 0, name: 'a' }), false)
  assert.equal(mod.validate({ name: 'a' }).valid, false)
}

describe('bundlers', () => {
  before(cleanGenerated)
  after(cleanGenerated)

  it('rollup', async () => {
    await cleanGenerated()
    const { rollup } = await import('rollup')
    const dir = await outDir('rollup')
    // Rollup has no project root; the plugin takes it as an option.
    const bundle = await rollup({ input: entry, plugins: [unplugin.rollup({ ...pluginOptions, root })] })
    await bundle.write({ file: path.join(dir, 'out.mjs'), format: 'es' })
    await bundle.close()
    await check(path.join(dir, 'out.mjs'))
  })

  it('rolldown', async () => {
    await cleanGenerated()
    const { rolldown } = await import('rolldown')
    const dir = await outDir('rolldown')
    const bundle = await rolldown({ input: entry, plugins: [unplugin.rolldown({ ...pluginOptions, root })] })
    await bundle.write({ file: path.join(dir, 'out.mjs'), format: 'es' })
    await bundle.close()
    await check(path.join(dir, 'out.mjs'))
  })

  it('vite', async () => {
    await cleanGenerated()
    const { build } = await import('vite')
    const dir = await outDir('vite')
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [unplugin.vite(pluginOptions)],
      build: {
        lib: { entry, formats: ['es'], fileName: () => 'out.mjs' },
        outDir: dir,
        emptyOutDir: true,
        minify: false,
      },
    })
    await check(path.join(dir, 'out.mjs'))
  })

  it('esbuild', async () => {
    await cleanGenerated()
    const esbuild = await import('esbuild')
    const dir = await outDir('esbuild')
    await esbuild.build({
      entryPoints: [entry],
      absWorkingDir: root,
      bundle: true,
      format: 'esm',
      outfile: path.join(dir, 'out.mjs'),
      plugins: [unplugin.esbuild(pluginOptions)],
      logLevel: 'silent',
    })
    await check(path.join(dir, 'out.mjs'))
  })

  it('webpack', async () => {
    await cleanGenerated()
    const { default: webpack } = await import('webpack')
    const dir = await outDir('webpack')
    await new Promise((resolve, reject) => {
      webpack(
        {
          mode: 'production',
          context: root,
          entry,
          experiments: { outputModule: true },
          output: { path: dir, filename: 'out.mjs', library: { type: 'module' } },
          optimization: { minimize: false },
          plugins: [unplugin.webpack(pluginOptions)],
        },
        (err, stats) => {
          if (err) return reject(err)
          if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true, all: false })))
          stats.compilation.compiler.close?.(() => resolve())
          resolve()
        },
      )
    })
    await check(path.join(dir, 'out.mjs'))
  })

  it('rspack', async () => {
    await cleanGenerated()
    const { rspack } = await import('@rspack/core')
    const dir = await outDir('rspack')
    await new Promise((resolve, reject) => {
      rspack(
        {
          mode: 'production',
          context: root,
          entry,
          experiments: { outputModule: true },
          output: { path: dir, filename: 'out.mjs', library: { type: 'module' } },
          optimization: { minimize: false },
          plugins: [unplugin.rspack(pluginOptions)],
        },
        (err, stats) => {
          if (err) return reject(err)
          if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true, all: false })))
          resolve()
        },
      )
    })
    await check(path.join(dir, 'out.mjs'))
  })

  it('exposes one factory per bundler plus the raw form', () => {
    for (const key of ['vite', 'rollup', 'rolldown', 'esbuild', 'webpack', 'rspack']) {
      assert.equal(typeof unplugin[key], 'function', key)
    }
    const vitePlugin = unplugin.vite(pluginOptions)
    assert.equal(vitePlugin.name, 'unplugin-ata')
    assert.equal(vitePlugin.enforce, 'pre')
    assert.equal(typeof vitePlugin.buildStart, 'function')
    assert.equal(typeof vitePlugin.watchChange, 'function')
    assert.equal(typeof vitePlugin.handleHotUpdate, 'function')
    assert.equal(typeof vitePlugin.configResolved, 'function')
  })
})
