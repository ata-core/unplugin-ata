// A part of a schema imported from a package of the same repository
// (`@acme/core/modules/auth.constants`): the package is found the way Node
// finds it, in a node_modules folder above the importing file, and read only
// where that entry is a link to source of the repository, not an installed
// dependency. Its `exports` map is followed for the subpath, a pattern with
// one `*` included. Nothing is loaded or run; the answer is a file to read as
// text, or null.
import fs from 'node:fs'
import path from 'node:path'

const SOURCE = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']
const CONDITIONS = ['source', 'import', 'default', 'require']

// What an exports entry points to: a path, or the first condition of the
// ones a bundler would take that leads to one. `types` is never taken.
const target = (value) => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) { for (const v of value) { const t = target(v); if (t) return t } return null }
  if (value && typeof value === 'object') { for (const c of CONDITIONS) if (c in value) { const t = target(value[c]); if (t) return t } }
  return null
}

function fromExports (exports, sub) {
  if (typeof exports === 'string' || Array.isArray(exports)) return sub === '.' ? target(exports) : null
  if (!exports || typeof exports !== 'object') return null
  const keys = Object.keys(exports)
  if (!keys.some((k) => k.startsWith('.'))) return sub === '.' ? target(exports) : null
  if (sub in exports) return target(exports[sub])
  // A pattern: the longest prefix wins, as in Node.
  let best = null
  for (const k of keys) {
    const star = k.indexOf('*')
    if (star === -1 || k.indexOf('*', star + 1) !== -1) continue
    const pre = k.slice(0, star); const post = k.slice(star + 1)
    if (sub.length < pre.length + post.length || !sub.startsWith(pre) || !sub.endsWith(post)) continue
    if (best === null || pre.length > best.pre.length) best = { pre, key: k, match: sub.slice(pre.length, sub.length - post.length) }
  }
  if (!best) return null
  const t = target(exports[best.key])
  return t ? t.split('*').join(best.match) : null
}

const existing = (file) => {
  const is = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
  if (SOURCE.includes(path.extname(file)) && is(file)) return file
  for (const e of SOURCE) if (is(file + e)) return file + e
  for (const e of SOURCE) { const p = path.join(file, 'index' + e); if (is(p)) return p }
  return null
}

// A relative import of a module the build's own resolver does not know: one
// inside a package of the repository, outside the application's root.
export function relativeResolve (spec, from) {
  if (typeof spec !== 'string' || spec[0] !== '.' || spec.includes('\u0000')) return null
  return existing(path.resolve(path.dirname(from), spec.split('?')[0]))
}

const packages = new Map()
export function workspaceResolve (spec, from) {
  if (typeof spec !== 'string' || spec === '' || spec[0] === '.' || spec[0] === '/' || spec[0] === '#' || spec.includes('\u0000') || /^[a-z]+:/i.test(spec)) return null
  const parts = spec.split('/')
  const name = spec[0] === '@' ? parts.slice(0, 2).join('/') : parts[0]
  if (spec[0] === '@' && parts.length < 2) return null
  const sub = '.' + spec.slice(name.length)
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    const at = path.join(dir, 'node_modules', name)
    let found = packages.get(at)
    if (found === undefined) {
      found = null
      try {
        const real = fs.realpathSync(at)
        // An installed dependency is not the application's source.
        if (!real.split(path.sep).includes('node_modules')) found = { real, pkg: JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8')) }
        else found = false
      } catch { found = null }
      packages.set(at, found)
    }
    if (found === false) return null
    if (found) {
      const { real, pkg } = found
      let rel = pkg.exports !== undefined ? fromExports(pkg.exports, sub) : sub === '.' ? (pkg.source || pkg.module || pkg.main || './index') : sub
      if (typeof rel !== 'string') return null
      const file = path.resolve(real, rel)
      // Never outside the package it names.
      if (file !== real && !file.startsWith(real + path.sep)) return null
      return existing(file)
    }
    if (path.dirname(dir) === dir) return null
  }
}
