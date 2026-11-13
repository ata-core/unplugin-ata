// What a page loads together, read from the project's own imports.
//
// `table` and `sharedErrors` in their 'auto' form trade a fixed cost (the
// plan interpreter, the shared error runtime) for a saving on each validator.
// The trade is good only where the validators that share the cost reach the
// browser together. Summed over a whole project it is not: a site of twenty
// pages with a form each saves bytes in total and puts the fixed cost on
// every page's first load.
//
// A load here is a root and every file it reaches through static imports. A
// root is one of the bundler's entries, where the plugin could read them and
// find each among the project's files, or the target of a dynamic import()
// the entries reach, where a bundler starts a chunk; files no entry reaches
// are not in the build and are left out. Where the entries are not known (a
// framework that makes its own, a bundler without a hook for them) a root is
// any file nothing imports statically, which counts a story or a script
// beside the application as a page of its own. The graph is read by expression, not parsed, over
// files already read for the scan. Where it is wrong it errs toward smaller
// loads: an import it cannot resolve leaves two files in separate loads, and
// a validator alone in a load keeps its written module, which is what the
// build gave before either option existed.

import fs from 'node:fs'
import path from 'node:path'

const STATIC = /(?:^|[\n;])[ \t]*(?:import|export)\s+(?!type[\s{])(?:[^'"()]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g
const REQUIRE = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

// The specifiers a file imports: `s` loaded with it, `d` on demand.
export function importsOf(code) {
  const s = []; const d = []
  if (!code.includes('import') && !code.includes('require') && !code.includes('export')) return { s, d }
  const found = []
  for (const m of code.matchAll(STATIC)) found.push([m.index, m[1]])
  for (const m of code.matchAll(REQUIRE)) found.push([m.index, m[1]])
  found.sort((a, b) => a[0] - b[0])
  for (const [, spec] of found) s.push(spec)
  for (const m of code.matchAll(DYNAMIC)) d.push(m[1])
  return { s, d }
}

const EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts', '.vue', '.svelte', '.astro']
// TypeScript sources name each other by the extension of the output.
const WRITTEN_AS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

// A resolver over the scanned files alone: no file system reads, and a
// package or an asset resolves to nothing.
export function resolverFor(all, root, aliases) {
  const file = (base) => {
    if (all.has(base)) return base
    for (const e of EXT) if (all.has(base + e)) return base + e
    const ext = path.extname(base)
    const alt = WRITTEN_AS[ext]
    if (alt) for (const e of alt) { const p = base.slice(0, -ext.length) + e; if (all.has(p)) return p }
    for (const e of EXT) { const p = path.join(base, 'index' + e); if (all.has(p)) return p }
    return null
  }
  return (spec, from) => {
    const q = spec.indexOf('?')
    if (q !== -1) spec = spec.slice(0, q)
    if (spec.startsWith('.')) return file(path.resolve(path.dirname(from), spec))
    for (const [find, target] of aliases) {
      if (spec === find || (find.endsWith('/') ? spec.startsWith(find) : spec.startsWith(find + '/'))) {
        const hit = file(path.join(target, spec.slice(find.length)))
        if (hit) return hit
      }
    }
    // Vite reads a leading slash from the project root.
    if (spec.startsWith('/')) return file(path.join(root, spec))
    return null
  }
}

function readJsonc(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  try { return JSON.parse(text) } catch {}
  // Comments and trailing commas, outside strings.
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (t) => t[0] === '"' ? t : '').replace(/,(\s*[}\]])/g, '$1')
  try { return JSON.parse(bare) } catch { return null }
}

// Aliases as [prefix, directory]: the bundler's own (Vite's resolve.alias,
// as the plugin already holds it), `paths` of the root's tsconfig.json or
// jsconfig.json, then the names frameworks give without configuration. An
// alias only ever resolves to a scanned file, so a wrong guess finds nothing.
export function aliasesFor(root, bundlerAlias) {
  const out = []
  for (const [find, target] of Object.entries(bundlerAlias || {})) out.push([find, path.resolve(root, target)])
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = readJsonc(path.join(root, name))
    const co = cfg && cfg.compilerOptions
    if (!co || !co.paths || typeof co.paths !== 'object') continue
    const base = path.resolve(root, typeof co.baseUrl === 'string' ? co.baseUrl : '.')
    for (const [key, targets] of Object.entries(co.paths)) {
      if (!Array.isArray(targets)) continue
      for (const t of targets) {
        if (typeof t !== 'string') continue
        if (key.endsWith('/*') && t.endsWith('/*')) out.push([key.slice(0, -1), path.resolve(base, t.slice(0, -1)) + path.sep])
        else if (!key.includes('*') && !t.includes('*')) out.push([key, path.resolve(base, t)])
      }
    }
  }
  const src = path.join(root, 'src')
  for (const dir of [src, root]) { out.push(['@/', dir + path.sep]); out.push(['~/', dir + path.sep]) }
  out.push(['$lib', path.join(src, 'lib')])
  return out
}

// The module scripts an HTML entry names, as specifiers.
export function htmlScripts(html) {
  const out = []
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) if (/\btype\s*=\s*["']module["']/i.test(m[0])) out.push(m[1])
  return out
}

// Map of root -> the files loaded with it. `files` is a Map of path ->
// { s, d } as importsOf gives them; `entries`, when given, are the
// bundler's entries as paths in `files`.
export function firstLoads(files, resolve, entries) {
  const edges = new Map(); const lazyEdges = new Map()
  const imported = new Set(); const lazy = new Set()
  for (const [id, { s, d }] of files) {
    const to = []; const later = []
    for (const spec of s) { const t = resolve(spec, id); if (t && t !== id) { to.push(t); imported.add(t) } }
    for (const spec of d) { const t = resolve(spec, id); if (t && t !== id) { later.push(t); lazy.add(t) } }
    edges.set(id, to); lazyEdges.set(id, later)
  }
  const loads = new Map(); const covered = new Set()
  const load = (root) => {
    const seen = new Set([root]); const stack = [root]
    while (stack.length) for (const t of edges.get(stack.pop()) || []) if (!seen.has(t)) { seen.add(t); stack.push(t) }
    loads.set(root, seen)
    for (const f of seen) covered.add(f)
  }
  if (Array.isArray(entries) && entries.length > 0 && entries.every((e) => files.has(e))) {
    const roots = new Set(entries); const seen = new Set(entries); const stack = [...entries]
    while (stack.length) {
      const f = stack.pop()
      for (const t of lazyEdges.get(f) || []) { roots.add(t); if (!seen.has(t)) { seen.add(t); stack.push(t) } }
      for (const t of edges.get(f) || []) if (!seen.has(t)) { seen.add(t); stack.push(t) }
    }
    for (const root of roots) load(root)
    return loads
  }
  for (const id of files.keys()) if (!imported.has(id) || lazy.has(id)) load(id)
  // Files that only import each other have no root above them.
  for (const id of files.keys()) if (!covered.has(id)) load(id)
  return loads
}

// The candidates that keep the trade: a file keeps it only where every load
// holding it pays, counted over the files still in. A file that leaves takes
// its saving out of the other loads it was in, so the loads are asked again
// until none changes. `pays` is asked with a sorted list of files.
export async function perLoad(loads, candidates, pays) {
  const groups = new Map()
  for (const reach of loads.values()) {
    const g = [...reach].filter((f) => candidates.has(f)).sort()
    if (g.length) groups.set(g.join('\0'), g)
  }
  const keep = new Set(); const answers = new Map()
  for (const g of groups.values()) for (const f of g) keep.add(f)
  for (;;) {
    let left = false
    for (const g of groups.values()) {
      const live = g.filter((f) => keep.has(f))
      if (!live.length) continue
      const key = live.join('\0')
      let ok = answers.get(key)
      if (ok === undefined) { ok = (await pays(live)) === true; answers.set(key, ok) }
      if (!ok) { for (const f of live) keep.delete(f); left = true }
    }
    if (!left) return keep
  }
}
