// Written into a file whose zodResolver call the build replaced (the text of
// this file, after the imports the build adds: __ataZNest, __ataZNative,
// __ataZAppend). It turns the errors of a compiled check into the issues zod
// reports, from tables the build learned by asking zod, and answers as
// zodResolver does. src/zod-resolver.js runs the same text at build time to
// hold each form to zod before its call is replaced.
const __ataZReceived = (v) => {
  const t = typeof v
  if (t === 'number') return Number.isNaN(v) ? 'NaN' : Number.isFinite(v) ? 'number' : String(v)
  if (t === 'object') { if (v === null) return 'null'; if (Array.isArray(v)) return 'array'; if (Object.getPrototypeOf(v) !== Object.prototype && 'constructor' in v && v.constructor) return v.constructor.name }
  return t
}
const __ataZSeg = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~')
const __ataZEsc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1')
const __ataZAt = (root, ip) => { let v = root; if (ip) for (const seg of ip.slice(1).split('/')) v = v == null ? undefined : v[__ataZSeg(seg)]; return v }
// What zod hands back: the declared keys, a key present with undefined kept.
const __ataZStrip = (P, ip, v) => { const k = P[ip].k; if (!k) return v; const out = {}; for (const key of k) if (key in v) { const c = v[key]; out[key] = c === undefined ? c : __ataZStrip(P, ip + '/' + __ataZEsc(key), c) } return out }
// zod's issues for a rejected document, in zod's order: [instancePath, code, message].
const __ataZIssues = (errors, T, P, values) => {
  const issues = []
  for (const e of errors) {
    if (e.keyword === 'required') { const ip = e.instancePath + '/' + __ataZEsc(e.params.missingProperty); const u = P[ip].u; issues.push([P[ip].o, -1, ip, u[0], u[1], 1]); continue }
    const entry = T[e.schemaPath]; const o = P[e.instancePath].o
    if (Array.isArray(entry)) { issues.push([o, entry[0], e.instancePath, entry[1], entry[2], 0]); continue }
    const v = __ataZAt(values, e.instancePath)
    // A number that is not whole: the int check's issue at its place among
    // the checks, and nothing after it.
    if (entry.i && typeof v === 'number' && Number.isFinite(v)) { issues.push([o, entry.i[0], e.instancePath, entry.i[1], entry.i[2], 1]); continue }
    issues.push([o, -1, e.instancePath, 'invalid_type', entry.t.m !== undefined ? entry.t.m : 'Invalid input: expected ' + entry.t.x + ', received ' + __ataZReceived(v), 1])
    // The wrong type stops the checks, except those on a length.
    if (entry.l && v != null && v.length !== undefined) for (const c of entry.l) if (c[0] ? v.length > c[1] : v.length < c[1]) issues.push([o, c[2], e.instancePath, c[3], Array.isArray(v) ? c[4] : c[5], 2])
  }
  issues.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []; let stopped = null
  for (const i of issues) { if (stopped === i[2] && i[5] !== 2) continue; if (i[5] === 1) stopped = i[2]; out.push([i[2], i[3], i[4]]) }
  return out
}
const __ataZodResolver = (compiled, T, P, ro) => async (values, _, options) => {
  const r = compiled.validate(values)
  if (r.valid) {
    options.shouldUseNativeValidation && __ataZNative({}, options)
    return { errors: {}, values: ro && ro.raw ? Object.assign({}, values) : __ataZStrip(P, '', values) }
  }
  const all = !options.shouldUseNativeValidation && options.criteriaMode === 'all'
  const errors = Object.create(null)
  for (const [ip, code, message] of __ataZIssues(r.errors, T, P, values)) {
    const path = ip === '' ? '' : ip.slice(1).split('/').map(__ataZSeg).join('.')
    if (!errors[path]) errors[path] = { message, type: code }
    if (all) { const types = errors[path].types; const messages = types && types[code]; errors[path] = __ataZAppend(path, all, errors, code, messages ? [].concat(messages, message) : message) }
  }
  return { values: {}, errors: __ataZNest(errors, options) }
}
