'use strict';
// A loader for Turbopack (next dev and next build in Next.js 16), which runs
// webpack loaders but not webpack plugins. It runs the plugin's own
// transform on each source file: one session per set of options, prepared
// once (schemas compiled, the shared-errors decision made) before the first
// file, as buildStart prepares it in every other bundler. Registered by
// `withAta` from @ata-project/unplugin/next, or by hand under
// `turbopack.rules`.
const sessions = new Map();

function sessionFor (options, root) {
  const key = JSON.stringify(options) + '\u0000' + root;
  let s = sessions.get(key);
  if (s === undefined) {
    s = import('./index.js').then(async ({ unpluginFactory }) => {
      const hooks = unpluginFactory({ root, ...options });
      await hooks.buildStart.call({});
      return hooks;
    });
    sessions.set(key, s);
  }
  return s;
}

module.exports = function ataTurbopackLoader (source) {
  const done = this.async();
  const options = (this.getOptions && this.getOptions()) || {};
  const file = this.resourcePath;
  sessionFor(options, this.rootContext || process.cwd()).then(async (hooks) => {
    if (!hooks.transformInclude(file)) return done(null, source);
    // Turbopack runs the loader once for the browser and once for the server.
    const out = await hooks.transform.call({}, source, file, { target: this.target });
    done(null, out ? out.code : source, out && out.map ? out.map : undefined);
  }, done).catch(done);
};
