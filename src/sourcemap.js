const fs = require('fs');
const path = require('path');

// Deliberately the 0.6.x line (not 0.7+, which requires an async WASM init
// step) — its API is fully synchronous, matching this module's one call
// site (errorLocationFields() in index.js runs inline during
// captureException(), never in an async context). Optional dependency:
// most Node backend apps run unbundled/unminified code and never hit this
// path at all.
let SourceMapConsumer = null;
try {
  ({ SourceMapConsumer } = require('source-map'));
} catch {
  // not installed — resolveOriginalPosition() below becomes a no-op.
}

// mapFilePath -> SourceMapConsumer | null, so a repeatedly-thrown error from
// the same bundled file only ever reads/parses its .map file once per
// process lifetime.
const consumerCache = new Map();

function loadConsumer(mapFilePath) {
  if (consumerCache.has(mapFilePath)) return consumerCache.get(mapFilePath);
  let consumer = null;
  try {
    const raw = fs.readFileSync(mapFilePath, 'utf8');
    consumer = new SourceMapConsumer(JSON.parse(raw));
  } catch {
    consumer = null;
  }
  consumerCache.set(mapFilePath, consumer);
  return consumer;
}

// Error Intelligence Phase 2 (Tier 2.4) — best-effort de-minification of a
// single stack frame's position, for bundled/minified backend deployments
// (e.g. an esbuild/webpack Lambda bundle) where the raw stack points at a
// minified file/line/column that means nothing to a human. Only handles the
// common "<file>.map sits next to <file> on disk" convention — inline
// base64 `sourceMappingURL` data-URI source maps are a known, documented
// gap, not implemented in this pass. Never throws; returns null (falling
// back to the raw minified position) if `source-map` isn't installed, no
// .map file exists next to the file, or the position can't be resolved.
function resolveOriginalPosition(file, line, column) {
  if (!SourceMapConsumer || !file) return null;
  const mapFilePath = `${file}.map`;
  if (!fs.existsSync(mapFilePath)) return null;
  const consumer = loadConsumer(mapFilePath);
  if (!consumer) return null;
  try {
    const original = consumer.originalPositionFor({ line, column });
    if (!original || original.line == null) return null;
    return {
      file: original.source ? path.resolve(path.dirname(file), original.source) : file,
      line: original.line,
      column: original.column,
      function: original.name || null,
    };
  } catch {
    return null;
  }
}

module.exports = { resolveOriginalPosition };
