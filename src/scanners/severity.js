// Every scanner (SonarQube, SARIF, npm audit) has its own severity scale —
// normalized here to one 5-level scale so the Security & Quality dashboard
// can sort/filter findings from any tool the same way.
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

function normalizeSeverity(value) {
  const lower = String(value || '').toLowerCase();
  return SEVERITIES.includes(lower) ? lower : 'info';
}

// SonarQube issue severities: BLOCKER > CRITICAL > MAJOR > MINOR > INFO.
function sonarSeverityToSeverity(sonarSeverity) {
  const map = { BLOCKER: 'critical', CRITICAL: 'high', MAJOR: 'medium', MINOR: 'low', INFO: 'info' };
  return map[sonarSeverity] || 'info';
}

// SonarQube ratings come back from the measures API as "1.0".."5.0",
// corresponding to letter grades A (best) to E (worst).
function sonarRatingToLetter(value) {
  const num = Math.round(parseFloat(value));
  return ['A', 'B', 'C', 'D', 'E'][num - 1] || null;
}

// SARIF's `level` (error/warning/note/none) is the fallback when a rule
// doesn't carry a numeric `security-severity` score (many security-focused
// tools, e.g. Trivy/Snyk's SARIF output, do carry one — prefer it when present).
function sarifLevelToSeverity(level) {
  const map = { error: 'high', warning: 'medium', note: 'low', none: 'info' };
  return map[level] || 'info';
}

// security-severity is a CVSS-like 0-10 score some SARIF producers attach
// to rule metadata — more precise than the generic `level` field.
function sarifScoreToSeverity(score) {
  const num = parseFloat(score);
  if (Number.isNaN(num)) return null;
  if (num >= 9) return 'critical';
  if (num >= 7) return 'high';
  if (num >= 4) return 'medium';
  if (num > 0) return 'low';
  return 'info';
}

// npm audit severities: critical/high/moderate/low/info — only "moderate"
// doesn't match our scale directly.
function npmAuditSeverityToSeverity(npmSeverity) {
  return npmSeverity === 'moderate' ? 'medium' : normalizeSeverity(npmSeverity);
}

module.exports = {
  SEVERITIES,
  normalizeSeverity,
  sonarSeverityToSeverity,
  sonarRatingToLetter,
  sarifLevelToSeverity,
  sarifScoreToSeverity,
  npmAuditSeverityToSeverity,
};
