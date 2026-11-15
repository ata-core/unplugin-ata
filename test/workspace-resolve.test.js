// A part of a schema imported from a package of the same repository is read
// from that package's source (src/workspace-resolve.js): found in a
// node_modules folder above the importing file, taken only where the entry
// links to source of the repository, by the package's exports map.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'

import esbuildPlugin from '../src/esbuild.js'
import { workspaceResolve, relativeResolve } from '../src/workspace-resolve.js'
import { show, clone } from './zod-forms.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const OPTS = [{ fields: {}, shouldUseNativeValidation: false }, { fields: {}, shouldUseNativeValidation: false, criteriaMode: 'all' }]

describe('a package of the same repository', () => {
  let repo; let app; let real
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
  before(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(here, 'fixtures', 'workspace-')))
    app = path.join(repo, 'apps', 'web')
    real = (p) => path.join(repo, 'packages', p)
    await write(real('core/package.json'), JSON.stringify({ name: '@acme/core', exports: { '.': './src/index.ts', './modules/*.constants': './src/modules/*.constants.ts', './built': { types: './dist/built.d.ts', import: './src/built.ts' }, './escape': '../../outside.ts', './missing': './src/missing.ts' } }))
    await write(real('core/src/index.ts'), `export * from './modules/auth.constants'\n`)
    await write(real('core/src/shared/limits.ts'), `export const MAX_PASSWORD = 72\n`)
    await write(real('core/src/modules/auth.constants.ts'), `import { z } from 'zod'\nimport { MAX_PASSWORD } from '../shared/limits'\nexport const zPassword = z.string().min(8, 'Too short').max(MAX_PASSWORD)\nexport const PROVIDERS = ['email', 'google'] as const\n`)
    await write(real('core/src/built.ts'), `export const BUILT = 1\n`)
    await write(real('plain/package.json'), JSON.stringify({ name: 'plain', main: './lib/main.js' }))
    await write(real('plain/lib/main.js'), `export const PLAIN = 1\n`)
    await write(real('plain/lib/deep.js'), `export const DEEP = 1\n`)
    await write(path.join(repo, 'outside.ts'), `export const OUTSIDE = 1\n`)
    // What an install does: the packages linked under node_modules, and a
    // dependency that is really installed there.
    await fs.mkdir(path.join(repo, 'node_modules', '@acme'), { recursive: true })
    await fs.symlink(real('core'), path.join(repo, 'node_modules', '@acme', 'core'))
    await fs.symlink(real('plain'), path.join(repo, 'node_modules', 'plain'))
    await write(path.join(repo, 'node_modules', 'installed', 'package.json'), JSON.stringify({ name: 'installed', main: './index.js' }))
    await write(path.join(repo, 'node_modules', 'installed', 'index.js'), `export const X = 1\n`)
    for (const dep of ['zod', '@hookform/resolvers', 'react-hook-form', 'ata-validator']) { const link = path.join(repo, 'node_modules', dep); await fs.mkdir(path.dirname(link), { recursive: true }); await fs.symlink(path.join(here, '..', 'node_modules', dep), link) }
    await write(path.join(app, 'form.ts'), `import { zodResolver } from '@hookform/resolvers/zod'\nimport { z } from 'zod'\nimport { zPassword, PROVIDERS } from '@acme/core/modules/auth.constants'\nimport { zPassword as again } from '@acme/core'\nconst schema = z.object({ password: zPassword, confirm: again, provider: z.enum(PROVIDERS) })\nexport const resolver = zodResolver(schema)\n`)
  })
  after(async () => { if (repo) await fs.rm(repo, { recursive: true, force: true }) })

  it('is found by its exports map: the entry, a subpath pattern, a condition', () => {
    const from = path.join(app, 'form.ts')
    assert.equal(workspaceResolve('@acme/core', from), real('core/src/index.ts'))
    assert.equal(workspaceResolve('@acme/core/modules/auth.constants', from), real('core/src/modules/auth.constants.ts'))
    assert.equal(workspaceResolve('@acme/core/built', from), real('core/src/built.ts'))
    assert.equal(workspaceResolve('plain', from), real('plain/lib/main.js'))
    assert.equal(workspaceResolve('plain/lib/deep', from), real('plain/lib/deep.js'))
  })
  it('is not read where the name is an installed dependency, is not exported, is not there, or leads out of the package', () => {
    const from = path.join(app, 'form.ts')
    for (const spec of ['installed', 'zod', 'nowhere', '@acme/nowhere', '@acme/core/modules/auth.routes', '@acme/core/src/shared/limits', '@acme/core/missing', '@acme/core/escape', '@acme', './form', '/etc/passwd', 'node:fs', 'plain/../core/package.json', '']) assert.equal(workspaceResolve(spec, from), null, spec)
    assert.equal(relativeResolve('../shared/limits', real('core/src/modules/auth.constants.ts')), real('core/src/shared/limits.ts'))
    assert.equal(relativeResolve('./nothing', from), null)
    assert.equal(relativeResolve('@acme/core', from), null)
  })
  it('names every module it read to the bundler, so a change to one rebuilds the form', async () => {
    const { unpluginFactory } = await import('../src/index.js')
    const hooks = unpluginFactory({ root: app, verify: false, report: false })
    await hooks.buildStart.call({})
    const watched = []
    const file = path.join(app, 'form.ts')
    const out = await hooks.transform.call({ addWatchFile: (f) => watched.push(f) }, await fs.readFile(file, 'utf8'), file)
    assert.match(out.code, /__ataZodResolver/)
    for (const f of ['core/src/modules/auth.constants.ts', 'core/src/shared/limits.ts', 'core/src/index.ts']) assert.ok(watched.includes(real(f)), `${f} was not named: ${watched.join(', ')}`)
    // A context without the hook (a bundler that has none) is not an error.
    const again = await hooks.transform.call({}, await fs.readFile(file, 'utf8'), file)
    assert.match(again.code, /__ataZodResolver/)
  })
  it('gives a form its parts: the call is replaced and answers as zodResolver', async () => {
    const esbuild = await import('esbuild')
    const out = path.join(app, 'dist', 'form.out.mjs')
    await esbuild.build({ absWorkingDir: app, entryPoints: ['form.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', plugins: [esbuildPlugin({ verify: false, report: false })] })
    const text = await fs.readFile(out, 'utf8')
    assert.match(text, /__ataZodResolver/)
    assert.doesNotMatch(text, /ZodError|_zod\b/, 'zod is still in the bundle')
    const { resolver } = await import(pathToFileURL(out).href)
    const password = z.string().min(8, 'Too short').max(72)
    const theirs = zodResolver(z.object({ password, confirm: password, provider: z.enum(['email', 'google']) }))
    for (const d of [{ password: 'longenough', confirm: 'longenough', provider: 'email' }, { password: 'a', confirm: 'x'.repeat(80), provider: 'github' }, {}]) for (const o of OPTS) assert.equal(show(await resolver(clone(d), undefined, o)), show(await theirs(clone(d), undefined, o)), `on ${show(d)}`)
  })
})
