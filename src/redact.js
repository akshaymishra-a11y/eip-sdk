// Best-effort scrubbing for the fields that regularly carry secrets/PII
// verbatim: unparameterized SQL literals, console.log output, error
// messages/stacks, and — as of Error Intelligence Phase 1 — request
// headers/body/query params. This is pattern matching, not a parser: it
// catches common shapes (key=value pairs, Authorization headers, JWTs,
// suspiciously-named object keys) but is not a substitute for parameterized
// queries or not logging secrets in the first place. Disable entirely via
// `eip.init({ redactSecrets: false })` if it ever mangles legitimate data.

const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9\-_.]+/gi;

// Header/base64url-payload/signature shape, e.g. "eyJhbGciOi....XYZ.abc123"
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// key: value / key=value / key="value" — where the key name itself signals
// a secret. Value is greedy up to the next quote/comma/whitespace/brace.
const SECRET_KEY_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)(["']?\s*[:=]\s*["']?)([^"'&,)\s}]+)/gi;

// Key names redacted regardless of user config — extendable via
// `redactionDenylist`, never fully disable-able (that's what
// `redactionAllowlist` is for, and only against these defaults — see
// shouldRedactKey below).
const DEFAULT_DENYLIST = [
  /password|passwd|pwd/i,
  /secret/i,
  /\btoken\b/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /x-api-key/i,
  /x-auth-token/i,
  /credit[_-]?card/i,
  /\bcvv\b/i,
  /\bssn\b/i,
];

// Values longer than this (after redaction) are truncated — protects
// against a huge/deeply-nested body inflating ingestion payload size even
// after secrets are stripped out of it.
const MAX_STRING_LENGTH = 2000;

function truncate(value) {
  return typeof value === 'string' && value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...***TRUNCATED***`
    : value;
}

function redactText(input) {
  if (typeof input !== 'string' || !input) return input;
  // Bearer/JWT go first: "Authorization: Bearer <token>" would otherwise get
  // caught by SECRET_KEY_PATTERN matching "Authorization" as the key and
  // "Bearer" (stopping at the space) as the "value" — redacting the literal
  // word "Bearer" while leaving the actual token exposed right after it.
  return input
    .replace(JWT_PATTERN, '***REDACTED_JWT***')
    .replace(BEARER_PATTERN, '$1***REDACTED***')
    .replace(SECRET_KEY_PATTERN, (_match, key, sep) => `${key}${sep}***REDACTED***`);
}

// Accepts a mixed array of plain strings (exact, case-insensitive match) and
// RegExp objects, so `redactionDenylist: ['x_internal_secret', /^x-.*-token$/i]`
// works.
function compileMatcher(entries) {
  const list = entries || [];
  return function matches(key) {
    return list.some((entry) => (entry instanceof RegExp ? entry.test(key) : entry.toLowerCase() === String(key).toLowerCase()));
  };
}

// createRedactor({ denylist, allowlist, maxDepth }) — precedence: user
// denylist always wins > user allowlist can rescue a *default*-denylist
// false positive (e.g. a field genuinely named "access_token_count") > the
// built-in default denylist > otherwise not redacted by key name. Every
// string leaf still runs through redactText()'s pattern scan regardless of
// whether its key matched, catching a secret embedded inside an
// innocuously-named field's string value.
function createRedactor(options) {
  const { denylist = [], allowlist = [], maxDepth = 6 } = options || {};
  const matchesUserDenylist = compileMatcher(denylist);
  const matchesUserAllowlist = compileMatcher(allowlist);
  const matchesDefaultDenylist = (key) => DEFAULT_DENYLIST.some((pattern) => pattern.test(String(key)));

  function shouldRedactKey(key) {
    if (matchesUserDenylist(key)) return true;
    if (matchesUserAllowlist(key)) return false;
    return matchesDefaultDenylist(key);
  }

  function redactValue(value, key, depth, seen) {
    if (key !== undefined && shouldRedactKey(key)) return '***REDACTED***';
    if (typeof value === 'string') return truncate(redactText(value));
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '***REDACTED_CIRCULAR***';
    if (depth >= maxDepth) return '***REDACTED_MAX_DEPTH***';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, undefined, depth + 1, seen));
    }
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = redactValue(v, k, depth + 1, seen);
    }
    return result;
  }

  // Recursive: handles nested objects/arrays, circular-safe, depth-capped.
  // Used for request_body/query_params/log metadata.
  function redactObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    return redactValue(obj, undefined, 0, new WeakSet());
  }

  // Flat map, case-insensitive key matching — headers are always a flat
  // string/string[] map, never worth the recursion redactObject() does.
  function redactHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const result = {};
    for (const [key, value] of Object.entries(headers)) {
      if (shouldRedactKey(key)) {
        result[key] = '***REDACTED***';
      } else if (typeof value === 'string') {
        result[key] = truncate(redactText(value));
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return { redactText, redactObject, redactHeaders, shouldRedactKey };
}

module.exports = { createRedactor, redactText };
