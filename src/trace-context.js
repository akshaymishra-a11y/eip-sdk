const crypto = require('crypto');

// W3C Trace Context (https://www.w3.org/TR/trace-context/) — one parsing/
// formatting implementation, shared by every server adapter (Express/
// Fastify/NestJS) and every outgoing HTTP instrumentation (fetch/axios), so
// there's exactly one place in the SDK that understands the traceparent/
// baggage wire format.
//
// Phase 1 simplification, stated rather than hidden: no sampling decision
// exists yet — every span/error is always recorded regardless of an
// incoming `sampled` flag, and outgoing headers always emit sampled=01.
// `sampled` is still threaded through end to end so a future `sampleRate`
// config doesn't require touching every adapter again.

const VERSION = '00';
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);

function generateTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

// Case-insensitive header lookup that works whether `headers` is a plain
// object (Express/Fastify's req.headers), a Headers instance (fetch), or an
// array-of-tuples-turned-object — the shapes this SDK actually encounters.
function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? undefined : value;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

// Rejects version 'ff' (reserved), malformed shape, and all-zero trace/parent
// ids (both explicitly invalid per the spec) — any of these mean "treat this
// exactly as if there was no incoming traceparent at all".
function parseTraceparent(header) {
  if (typeof header !== 'string') return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;
  const [, version, traceId, parentId, flags] = match;
  if (version.toLowerCase() === 'ff') return null;
  if (traceId === ALL_ZERO_TRACE_ID || parentId === ALL_ZERO_SPAN_ID) return null;
  return { version, traceId: traceId.toLowerCase(), parentId: parentId.toLowerCase(), flags: flags.toLowerCase() };
}

function formatTraceparent({ traceId, spanId, sampled = true }) {
  return `${VERSION}-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

function parseBaggage(header) {
  if (typeof header !== 'string' || !header.trim()) return {};
  const result = {};
  header.split(',').forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const rawKey = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1).trim();
    if (!rawKey) return;
    try {
      result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      result[rawKey] = rawValue;
    }
  });
  return result;
}

function formatBaggage(entries) {
  const keys = Object.keys(entries || {});
  if (!keys.length) return '';
  return keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(entries[key])}`).join(',');
}

// tracestate (https://www.w3.org/TR/trace-context/#tracestate-header) is a
// vendor-extensible, ORDER-SIGNIFICANT list ("most recently mutated first"),
// unlike baggage — no percent-encoding in the spec's grammar, so this is
// intentionally simpler than parseBaggage/formatBaggage above: split on
// commas, split each entry on the first '=', done. Soft-capped at the
// spec-recommended 32 list-members; malformed entries (no '=') and repeated
// keys (keep the first/most-recent occurrence) are dropped rather than
// rejecting the whole header, since a strict reject would throw away a
// perfectly good trace just because one vendor's entry was malformed.
const MAX_TRACESTATE_MEMBERS = 32;

function parseTracestate(header) {
  if (typeof header !== 'string' || !header.trim()) return [];
  const members = [];
  const seen = new Set();
  header.split(',').forEach((entry) => {
    const eq = entry.indexOf('=');
    if (eq === -1) return;
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    members.push({ key, value });
  });
  return members.slice(0, MAX_TRACESTATE_MEMBERS);
}

function formatTracestate(members) {
  if (!members || !members.length) return '';
  return members
    .slice(0, MAX_TRACESTATE_MEMBERS)
    .map((m) => `${m.key}=${m.value}`)
    .join(',');
}

// A system that mutates tracestate must move its own entry to the front and
// must not leave a stale duplicate of its own key elsewhere in the list
// (spec section 3.3.1.4) — every other vendor's entry is otherwise forwarded
// completely unmodified, which is the spec's minimum-compliant behavior for
// data this SDK doesn't understand.
function withOwnTracestateEntry(members, vendorKey, value) {
  const filtered = (members || []).filter((m) => m.key !== vendorKey);
  return [{ key: vendorKey, value }, ...filtered].slice(0, MAX_TRACESTATE_MEMBERS);
}

// Reads an incoming request's headers and returns the context this service
// should operate under: continues an existing trace when a valid
// traceparent is present, otherwise mints a brand new one (parentSpanId:
// null — the same invariant a genuinely-new trace always had before this
// module existed, which the dashboard's root-span lookup depends on).
// `tracestate` is parsed independently of traceparent validity — per spec,
// a system MUST forward tracestate even when it starts a brand-new trace of
// its own (a fresh trace-id can still be correlated with the caller's
// tracestate-carried vendor data).
function extractIncomingContext(headers) {
  const parsed = parseTraceparent(getHeader(headers, 'traceparent'));
  const baggage = parseBaggage(getHeader(headers, 'baggage'));
  const tracestate = parseTracestate(getHeader(headers, 'tracestate'));
  if (!parsed) {
    return { traceId: generateTraceId(), spanId: generateSpanId(), parentSpanId: null, sampled: true, baggage, tracestate };
  }
  return {
    traceId: parsed.traceId,
    spanId: generateSpanId(),
    parentSpanId: parsed.parentId,
    sampled: parsed.flags !== '00',
    baggage,
    tracestate,
  };
}

// Builds the headers to merge onto an outgoing request so the next service
// in the chain continues this trace. `childSpanId` must be the exact same id
// the caller records as the span_id of the resulting client/external span —
// otherwise the parent-child link between this service's span and the
// downstream service's continued trace is orphaned. Also true for the
// tracestate entry this function adds (vendor key 'eip') — it carries the
// same childSpanId, so a tracestate-aware reader can correlate a hop's
// tracestate entry with its span without decoding traceparent at all.
function buildOutgoingHeaders({ traceId, childSpanId, sampled = true, baggage, tracestate }) {
  const headers = { traceparent: formatTraceparent({ traceId, spanId: childSpanId, sampled }) };
  const baggageHeader = formatBaggage(baggage);
  if (baggageHeader) headers.baggage = baggageHeader;
  const tracestateHeader = formatTracestate(withOwnTracestateEntry(tracestate, 'eip', childSpanId));
  if (tracestateHeader) headers.tracestate = tracestateHeader;
  return headers;
}

module.exports = {
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  formatTraceparent,
  parseBaggage,
  formatBaggage,
  parseTracestate,
  formatTracestate,
  withOwnTracestateEntry,
  extractIncomingContext,
  buildOutgoingHeaders,
  getHeader,
};
