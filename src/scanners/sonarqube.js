const { sonarSeverityToSeverity, sonarRatingToLetter } = require('./severity');

// Structurally complete against the real SonarQube Web API, but not
// live-tested against a real SonarQube server in dev — none was available
// in that environment. Verify against a real server before relying on this
// in production.
//
// SonarQube's Web API auth is HTTP Basic with the token as the username and
// an empty password: https://docs.sonarqube.org/latest/extend/web-api/
function authHeader(token) {
  return { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` };
}

const MEASURE_METRICS = [
  'bugs',
  'vulnerabilities',
  'code_smells',
  'security_hotspots',
  'coverage',
  'duplicated_lines_density',
  'security_rating',
  'reliability_rating',
  'sqale_rating', // SonarQube's internal name for the maintainability rating
];

async function fetchQualityGateStatus(sonarUrl, token, projectKey) {
  const res = await fetch(`${sonarUrl}/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`, {
    headers: authHeader(token),
  });
  if (!res.ok) throw new Error(`SonarQube quality gate request failed: ${res.status}`);
  const data = await res.json();
  const status = data.projectStatus && data.projectStatus.status;
  const map = { OK: 'passed', ERROR: 'failed', WARN: 'warn' };
  return map[status] || null;
}

async function fetchMeasures(sonarUrl, token, projectKey) {
  const res = await fetch(
    `${sonarUrl}/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${MEASURE_METRICS.join(',')}`,
    { headers: authHeader(token) }
  );
  if (!res.ok) throw new Error(`SonarQube measures request failed: ${res.status}`);
  const data = await res.json();
  const measures = (data.component && data.component.measures) || [];
  const byMetric = Object.fromEntries(measures.map((m) => [m.metric, m.value]));

  return {
    bugs: byMetric.bugs != null ? parseInt(byMetric.bugs, 10) : null,
    vulnerabilities: byMetric.vulnerabilities != null ? parseInt(byMetric.vulnerabilities, 10) : null,
    codeSmells: byMetric.code_smells != null ? parseInt(byMetric.code_smells, 10) : null,
    securityHotspots: byMetric.security_hotspots != null ? parseInt(byMetric.security_hotspots, 10) : null,
    coverage: byMetric.coverage != null ? parseFloat(byMetric.coverage) : null,
    duplicatedLinesDensity: byMetric.duplicated_lines_density != null ? parseFloat(byMetric.duplicated_lines_density) : null,
    securityRating: byMetric.security_rating != null ? sonarRatingToLetter(byMetric.security_rating) : null,
    reliabilityRating: byMetric.reliability_rating != null ? sonarRatingToLetter(byMetric.reliability_rating) : null,
    maintainabilityRating: byMetric.sqale_rating != null ? sonarRatingToLetter(byMetric.sqale_rating) : null,
  };
}

// Capped at one page (500, SonarQube's max page size) for v1 — a project
// with more open issues than that only reports its first 500, which is
// still enough to populate a useful findings feed.
async function fetchIssues(sonarUrl, token, projectKey) {
  const res = await fetch(
    `${sonarUrl}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&resolved=false&types=VULNERABILITY,BUG&ps=500`,
    { headers: authHeader(token) }
  );
  if (!res.ok) throw new Error(`SonarQube issues request failed: ${res.status}`);
  const data = await res.json();

  return (data.issues || []).map((issue) => ({
    severity: sonarSeverityToSeverity(issue.severity),
    type: issue.type === 'BUG' ? 'bug' : 'vulnerability',
    title: issue.message,
    description: issue.rule || null,
    filePath: issue.component ? issue.component.split(':').pop() : null,
    lineNumber: issue.line || null,
  }));
}

async function fetchSonarQubeReport({ sonarUrl, token, projectKey }) {
  if (!sonarUrl || !token || !projectKey) {
    throw new Error('[eip-scan-report] --sonarqube requires --sonar-url, --sonar-token, and --project-key');
  }

  const [qualityGateStatus, measures, findings] = await Promise.all([
    fetchQualityGateStatus(sonarUrl, token, projectKey),
    fetchMeasures(sonarUrl, token, projectKey),
    fetchIssues(sonarUrl, token, projectKey),
  ]);

  return { summary: { qualityGateStatus, ...measures }, findings };
}

module.exports = { fetchSonarQubeReport };
