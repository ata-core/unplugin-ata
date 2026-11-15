// Written into a file whose zodResolver call or zod schema the build replaced
// (the text of this file; where a resolver is written, after the imports the
// build adds for it: __ataZNest, __ataZNative, __ataZAppend). It turns the errors of a compiled check into the issues zod
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
// A place in the tables is a path with `*` for an item of an array: the
// pattern of an instance path, and its place in zod's order (the order of
// each field on the way down, an item by its index).
const __ataZPat = (P, ip) => { let pat = ''; if (ip) for (const seg of ip.slice(1).split('/')) pat += P[pat].a ? '/*' : '/' + seg; return pat }
const __ataZKey = (P, ip) => { const key = []; let pat = ''; if (ip) for (const seg of ip.slice(1).split('/')) { if (P[pat].a) { key.push(+seg); pat += '/*' } else { pat += '/' + seg; key.push(P[pat].o) } } return key }
// What zod hands back: the declared keys, a key present with undefined kept,
// an array item by item.
const __ataZStrip = (P, pat, v) => {
  const n = P[pat]
  if (n.a) return Array.isArray(v) ? Array.from(v, (x) => __ataZStrip(P, pat + '/*', x)) : v
  if (!n.k) return n.x && typeof v === 'string' ? __ataZOps(n.x, v) : v
  const out = {}
  for (const key of n.k) if (key in v) { const c = v[key]; out[key] = c === undefined ? c : __ataZStrip(P, pat + '/' + __ataZEsc(key), c) }
  return out
}
//<rewrites>
// 0 trim, 1 toLowerCase, 2 toUpperCase, 3 a coercion to a number, 4 what
// url() hands back: the value trimmed, without ASCII tabs and line breaks.
const __ataZOps = (ops, v) => { for (const op of ops) v = op === 0 ? v.trim() : op === 1 ? v.toLowerCase() : op === 2 ? v.toUpperCase() : op === 3 ? Number(v) : v.trim().replace(/[\t\n\r]/g, ''); return v }
// A value zod rewrites before it checks it (trim, toLowerCase, toUpperCase,
// a coercion to a number) is rewritten in a copy of the document, which is
// what the check then reads.
const __ataZPrep = (P, pat, v) => {
  const n = P[pat]
  if (n.a) return Array.isArray(v) ? Array.from(v, (x) => __ataZPrep(P, pat + '/*', x)) : v
  // A coercion (3) takes whatever came, except nothing where nothing is allowed.
  if (!n.k) return n.w && (n.w[0] === 3 ? !(n.q && v === undefined) : typeof v === 'string') ? __ataZOps(n.w, v) : v
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const out = Object.assign({}, v)
  for (const key of n.k) if (key in v) out[key] = __ataZPrep(P, pat + '/' + __ataZEsc(key), v[key])
  return out
}
//</rewrites>
//<refines>
// refine(): each function of the schema, run where zod runs it. zod parses a
// node's children, then runs the node's checks in order, and skips a refine
// once something before it has stopped the node: a wrong type, a missing
// value, an enum that does not match or an oversized array anywhere under
// it, or an earlier check of its own that stops. A length or a pattern that
// fails does not stop it. R is [pattern, rank, function, message, path, stops,
// code: 'custom' when left out]
// in that order of evaluation; an issue is [order key, rank, path, code,
// message, stop, owner, stops (2: outright), an array's own length check].
const __ataZRefine = (issues, P, R, F, doc) => {
  const places = (pat) => {
    let out = ['']
    if (pat) for (const seg of pat.slice(1).split('/')) {
      const next = []
      for (const ip of out) {
        if (seg === '*' && P[__ataZPat(P, ip)].a) { const v = __ataZAt(doc, ip); if (Array.isArray(v)) for (let i = 0; i < v.length; i++) next.push(ip + '/' + i) } else next.push(ip + '/' + seg)
      }
      out = next
    }
    return out
  }
  for (const r of R) for (const ip of places(r[0])) {
    const v = __ataZAt(doc, ip)
    if (v === undefined) continue
    if (issues.some((i) => (i[5] === 1 || i[7]) && (i[6] === ip ? i[1] < r[1] : i[6].startsWith(ip + '/') || ip.startsWith(i[6] + '/')))) continue
    // zod hands a refine what it has parsed so far: an object or an array as
    // it would be handed back, unknown keys gone.
    const whole = P[r[0]].k || P[r[0]].a
    if (F[r[2]](whole ? __ataZStrip(P, r[0], v) : v)) continue
    const key = __ataZKey(P, ip)
    if (whole) key.push(Infinity)
    issues.push([key, r[1], ip + r[4], r[6] || 'custom', r[3] === null ? 'Invalid input' : r[3], r[5], ip, r[5] ? 2 : 0])
  }
}
//</refines>
//<strict>
// A strict object: the keys the schema does not name, in one issue of the
// object, after what is said about its fields and before its own refines.
// zod reads every enumerable key, an inherited one too, and reads no object
// that is not one or that stands under an array it found too long. The keys
// are read from the document as it was given, not from the copy a rewrite
// made: __ataZRun leaves it in __ataZGiven for the one call that reads it, so
// a file without a strict object carries neither the walk nor a way to it.
let __ataZGiven
const __ataZStrict = (issues, P, pat, ip, v) => {
  const n = P[pat]
  if (n.a) { if (Array.isArray(v)) for (let i = 0; i < v.length; i++) __ataZStrict(issues, P, pat + '/*', ip + '/' + i, v[i]); return }
  if (!n.k || v === null || typeof v !== 'object' || Array.isArray(v)) return
  if (n.s) {
    const keys = []
    for (const key in v) if (!n.k.includes(key)) keys.push(key)
    if (keys.length) issues.push([__ataZKey(P, ip).concat(Infinity), -1, ip, 'unrecognized_keys', n.s === 1 ? 'Unrecognized key' + (keys.length > 1 ? 's' : '') + ': ' + keys.map((k) => '"' + k + '"').join(', ') : n.s, 0, ip, 0])
  }
  for (const key of n.k) if (key in v) { const e = '/' + __ataZEsc(key); __ataZStrict(issues, P, pat + e, ip + e, v[key]) }
}
//</strict>
// zod's issues for a rejected document, in zod's order: [instancePath, code, message].
const __ataZIssues = (errors, T, P, values, R, F) => {
  let issues = []; const capped = []
  for (const e of errors) {
    if (e.keyword === 'required') { const ip = e.instancePath + '/' + __ataZEsc(e.params.missingProperty); const u = P[__ataZPat(P, ip)].u; issues.push([__ataZKey(P, ip), -1, ip, u[0], u[1], 1, ip]); continue }
    const entry = T[e.schemaPath]; const ip = e.instancePath; const key = __ataZKey(P, ip)
    if (Array.isArray(entry)) {
      // A check of an array itself comes after its items; one that caps its
      // length is the only thing zod says about an array longer than that.
      if (entry[3]) { key.push(Infinity); if (entry[3] === 2) capped.push(ip + '/') }
      issues.push([key, entry[0], ip, entry[1], entry[2], 0, ip, entry[3] === 2 ? 2 : entry[4], entry[3]]); continue
    }
    const v = __ataZAt(values, ip)
    // A number that is not whole: the int check's issue at its place among
    // the checks, and nothing after it. zod stops outright on it, so an
    // array above it does not have its own length checked either.
    if (entry.i && typeof v === 'number' && Number.isFinite(v)) { issues.push([key, entry.i[0], ip, entry.i[1], entry.i[2], 1, ip, 2]); continue }
    issues.push([key, -1, ip, 'invalid_type', entry.t.m !== undefined ? entry.t.m : 'Invalid input: expected ' + entry.t.x + ', received ' + __ataZReceived(v), 1, ip])
    // The wrong type stops the checks, except those on a length, worded by
    // what was given: the other kind that has one (c[4]), or anything else.
    if (entry.l && v != null && v.length !== undefined) for (const c of entry.l) if (c[0] ? v.length > c[1] : v.length < c[1]) issues.push([key, c[2], ip, c[3], (entry.s ? typeof v === 'string' : Array.isArray(v)) ? c[4] : c[5], 2, ip])
  }
//<strict>
  if (P[''].z) __ataZStrict(issues, P, '', '', __ataZGiven)
//</strict>
  // zod does not read the items of an oversized array: what the check
  // found under one is not something zod would have said.
  if (capped.length) issues = issues.filter((i) => !capped.some((c) => i[6].startsWith(c)))
  if (R) __ataZRefine(issues, P, R, F, values)
  issues.sort((a, b) => { for (let i = 0; ; i++) { const x = a[0][i]; const y = b[0][i]; if (x === undefined || y === undefined) return (x === undefined ? 0 : 1) - (y === undefined ? 0 : 1) || a[1] - b[1]; if (x !== y) return x - y } })
  const out = []; let stopped = null
  // An array's own length check is not run once something under it was
  // stopped outright: an oversized array, or a refine written to stop.
  for (const i of issues) { if (i[8] && issues.some((x) => x[7] === 2 && x[6].startsWith(i[6] + '/'))) continue; if (stopped === i[6] && i[5] !== 2) continue; if (i[5] === 1) stopped = i[6]; out.push([i[2], i[3], i[4]]) }
  return out
}
// One document: { data } as zod returns it, or { issues } as zod reports them.
// A schema with refine() runs its functions on a document the check passed too.
const __ataZRun = (validate, T, P, values, R, F) => {
  const doc = P[''].p ? __ataZPrep(P, '', values) : values
  const r = validate(doc)
//<strict>
  // A document the check passed can still hold a key a strict object does
  // not name.
  if (P[''].z) { __ataZGiven = values; const found = __ataZIssues(r.valid ? [] : r.errors, T, P, doc, R, F); __ataZGiven = undefined; return found.length ? { issues: found } : { data: __ataZStrip(P, '', doc) } }
//</strict>
  if (r.valid && !R) return { data: __ataZStrip(P, '', doc) }
  const issues = __ataZIssues(r.valid ? [] : r.errors, T, P, doc, R, F)
  return issues.length ? { issues } : { data: __ataZStrip(P, '', doc) }
}
//<resolver>
const __ataZodResolver = (compiled, T, P, ro, R, F) => async (values, _, options) => {
  const r = __ataZRun(compiled.validate, T, P, values, R, F)
  if (r.issues === undefined) {
    options.shouldUseNativeValidation && __ataZNative({}, options)
    return { errors: {}, values: ro && ro.raw ? Object.assign({}, values) : r.data }
  }
  const all = !options.shouldUseNativeValidation && options.criteriaMode === 'all'
  const errors = Object.create(null)
  for (const [ip, code, message] of r.issues) {
    const path = ip === '' ? '' : ip.slice(1).split('/').map(__ataZSeg).join('.')
    if (!errors[path]) errors[path] = { message, type: code }
    if (all) { const types = errors[path].types; const messages = types && types[code]; errors[path] = __ataZAppend(path, all, errors, code, messages ? [].concat(messages, message) : message) }
  }
  return { values: {}, errors: __ataZNest(errors, options) }
}
//</resolver>
//<parse>
// schema.safeParse(value), for a file that reads what it returns through
// success, data, and the code, path and message of each issue, and through
// nothing else (src/error-use.js decides that). A path is zod's: a key as a
// string, an item of an array by its index as a number.
const __ataZPath = (P, ip) => { const out = []; let pat = ''; if (ip) for (const seg of ip.slice(1).split('/')) { const n = P[pat]; if (n && n.a) { out.push(+seg); pat += '/*' } else { out.push(__ataZSeg(seg)); pat += '/' + seg } } return out }
const __ataZSchema = (compiled, T, P, R, F) => ({ safeParse: (values) => { const r = __ataZRun(compiled.validate, T, P, values, R, F); return r.issues === undefined ? { success: true, data: r.data } : { success: false, error: { issues: r.issues.map((i) => ({ code: i[1], path: __ataZPath(P, i[0]), message: i[2] })) } } } })
//</parse>
//<flat>
// error.flatten() and z.flattenError(error), with no mapper: the messages
// under the first key of each path, and those of the whole in formErrors.
// A key is the object's own, as in zod: one named like a method of every
// object, or __proto__, is a field like any other.
const __ataZFlat = (error) => {
  const formErrors = []; const fieldErrors = {}
  for (const i of error.issues) {
    if (i.path.length === 0) { formErrors.push(i.message); continue }
    const k = i.path[0]
    if (!Object.prototype.hasOwnProperty.call(fieldErrors, k)) { if (k === '__proto__') Object.defineProperty(fieldErrors, k, { value: [], writable: true, enumerable: true, configurable: true }); else fieldErrors[k] = [] }
    fieldErrors[k].push(i.message)
  }
  return { formErrors, fieldErrors }
}
//</flat>
