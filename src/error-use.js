// Whether a file's code can tell rich errors from plain ones.
//
// A validator made without options gives rich errors: each has the five
// fields of a plain error (keyword, instancePath, schemaPath, params,
// message) and ten more (code, docUrl, expected, received, suggestion and
// the rest). The five hold the same values in the same order either way. So
// where every error a validator produces is only ever read through those
// five, the validator can be written with plain errors and the code computes
// what it computed, with the rich pipeline (previews, suggestions, the edit
// distance behind them) out of the bundle.
//
// This file decides "only ever read through those five" and nothing else.
// It follows the result of each validate() call through the shapes below
// and answers false at the first use it does not know: an error, the list or
// the result handed to a call, returned, spread, stored in an object or an
// array, read by a computed key, or reached through a name declared twice in
// its function. False keeps the rich errors, which is what the code had.

const PLAIN_FIELDS = new Set(['keyword', 'instancePath', 'schemaPath', 'params', 'message'])
const RESULT_FIELDS = new Set(['valid', 'data'])
// Array methods called with a function that takes each error. What `map`
// and the others return holds an error only if the function returns one,
// which is a use this file refuses inside the function.
const EACH = new Set(['map', 'forEach', 'some', 'every', 'findIndex', 'findLastIndex', 'flatMap'])
const ONE = new Set(['find', 'findLast'])
const LIST = new Set(['filter'])

const isMember = (n) => n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')
const isCall = (n) => n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression')
const isFunction = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod')
const named = (m) => !m.computed && m.property.type === 'Identifier' ? m.property.name : null

// `scan` is compile-away's walk (declarations counted, value references
// listed), asked here of one function at a time so that `r` and `e` may be
// names every handler in the file uses.
export function readsOnlyPlainFields(calls, scan) {
  const scopes = new Map()
  const scopeOf = (node) => { let n = node.__parent; while (n && !isFunction(n) && n.type !== 'Program') n = n.__parent; return n || null }
  // The references to `name`, declared at `at`, or null where the name is
  // declared more than once in its function and they cannot be told apart.
  const refsTo = (name, at) => {
    const scope = isFunction(at) ? at : scopeOf(at)
    if (!scope) return null
    let s = scopes.get(scope)
    if (!s) { s = scan({ program: scope }); scopes.set(scope, s) }
    if (s.declared.get(name) !== 1) return null
    return s.refs.filter((r) => r.node.name === name).map((r) => r.node)
  }
  // `binding` is the name's own place in a pattern; the walk lists it, and
  // the key beside it in `{ errors }`, with the references.
  const all = (name, at, use, binding) => { const refs = refsTo(name, at); return refs !== null && refs.every((n) => (binding !== undefined && n.__parent === binding.__parent) || use(n)) }
  // An object pattern over an error or a result: plain keys from `allowed`,
  // no rest; `onValue` is asked about each bound value.
  const pattern = (p, allowed, onValue) => p.properties.every((prop) => {
    if (prop.type !== 'ObjectProperty' || prop.computed || prop.key.type !== 'Identifier' || !allowed(prop.key.name)) return false
    return onValue(prop.key.name, prop.value)
  })
  const errorPattern = (p) => pattern(p, (k) => PLAIN_FIELDS.has(k), () => true)
  const constOf = (decl) => decl.__parent && decl.__parent.type === 'VariableDeclaration' && decl.__parent.kind === 'const'
  const through = (n) => { let p = n.__parent; while (p && (p.type === 'TSNonNullExpression' || p.type === 'TSAsExpression' || p.type === 'TSSatisfiesExpression')) { n = p; p = p.__parent } return [n, p] }

  // `node` evaluates to one error, or to nothing.
  const error = (node0) => {
    const [node, p] = through(node0)
    if (!p) return false
    if (isMember(p) && p.object === node) { const k = named(p); return k !== null && PLAIN_FIELDS.has(k) }
    if (p.type === 'VariableDeclarator' && p.init === node && constOf(p)) {
      if (p.id.type === 'Identifier') return all(p.id.name, p, error)
      if (p.id.type === 'ObjectPattern') return errorPattern(p.id)
      return false
    }
    // Asked only whether there is one.
    if ((p.type === 'IfStatement' || p.type === 'ConditionalExpression') && p.test === node) return true
    if (p.type === 'UnaryExpression' && p.operator === '!') return true
    if (p.type === 'LogicalExpression' && p.operator === '&&' && p.left === node) return true
    return false
  }
  // A parameter or a loop variable that holds an error.
  const errorBinding = (b, at) => {
    if (!b) return true
    if (b.type === 'Identifier') return all(b.name, at, error)
    if (b.type === 'ObjectPattern') return errorPattern(b)
    return false
  }
  // `node` evaluates to the list of errors, or a list of some of them.
  const errors = (node0) => {
    const [node, p] = through(node0)
    if (!p) return false
    if (isMember(p) && p.object === node) {
      if (p.computed) return error(p)
      const k = named(p)
      if (k === 'length') return true
      const call = p.__parent
      if (!isCall(call) || call.callee !== p) return false
      if (k === 'at') return call.arguments.every((a) => a.type !== 'SpreadElement') && error(call)
      if (!EACH.has(k) && !ONE.has(k) && !LIST.has(k)) return false
      const fn = call.arguments[0]
      if (call.arguments.length !== 1 || !fn || fn.type !== 'ArrowFunctionExpression' || fn.params.length > 2) return false
      if (!errorBinding(fn.params[0], fn)) return false
      return EACH.has(k) ? true : ONE.has(k) ? error(call) : errors(call)
    }
    if (p.type === 'VariableDeclarator' && p.init === node && constOf(p) && p.id.type === 'Identifier') return all(p.id.name, p, errors)
    if (p.type === 'ForOfStatement' && p.right === node && !p.await) {
      const left = p.left
      if (!left || left.type !== 'VariableDeclaration' || left.declarations.length !== 1 || left.declarations[0].init) return false
      return errorBinding(left.declarations[0].id, left.declarations[0])
    }
    return false
  }
  // `node` evaluates to what validate() returned.
  const result = (node0) => {
    const [node, p] = through(node0)
    if (!p) return false
    if (p.type === 'ExpressionStatement') return true
    if (isMember(p) && p.object === node) {
      const k = named(p)
      if (k === null) return false
      if (RESULT_FIELDS.has(k)) return true
      return k === 'errors' && errors(p)
    }
    if (p.type === 'VariableDeclarator' && p.init === node && constOf(p)) {
      if (p.id.type === 'Identifier') return all(p.id.name, p, result)
      if (p.id.type === 'ObjectPattern') {
        return pattern(p.id, (k) => RESULT_FIELDS.has(k) || k === 'errors', (k, value) => {
          if (k !== 'errors') return true
          return value.type === 'Identifier' && all(value.name, p, errors, value)
        })
      }
    }
    return false
  }
  return calls.every(result)
}
