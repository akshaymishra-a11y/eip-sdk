const fs = require('fs');
const { sarifLevelToSeverity, sarifScoreToSeverity } = require('./severity');

// SARIF (Static Analysis Results Interchange Format) is the one parser that
// covers "any other security tool" broadly — Trivy, Snyk, CodeQL, Semgrep,
// ESLint, Bandit, and many others can all emit it. Spec:
// https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
function parseSarifFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = JSON.parse(raw);
  const runs = doc.runs || [];

  const findings = [];
  for (const run of runs) {
    // Rule metadata (including an optional numeric security-severity score)
    // lives separately from the results and is looked up by ruleId.
    const rules = (run.tool && run.tool.driver && run.tool.driver.rules) || [];
    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));

    for (const result of run.results || []) {
      const rule = ruleById.get(result.ruleId);
      const securityScore = rule && rule.properties && rule.properties['security-severity'];
      const severity = (securityScore && sarifScoreToSeverity(securityScore)) || sarifLevelToSeverity(result.level);

      const location = result.locations && result.locations[0] && result.locations[0].physicalLocation;
      const filePath2 = location && location.artifactLocation && location.artifactLocation.uri;
      const lineNumber = location && location.region && location.region.startLine;

      findings.push({
        severity,
        type: 'vulnerability',
        title: result.ruleId || (rule && rule.name) || 'Untitled finding',
        description: (result.message && result.message.text) || null,
        filePath: filePath2 || null,
        lineNumber: lineNumber || null,
      });
    }
  }

  const summary = {
    vulnerabilities: findings.length,
    bugs: null,
    codeSmells: null,
    securityHotspots: null,
    coverage: null,
    duplicatedLinesDensity: null,
    securityRating: null,
    reliabilityRating: null,
    maintainabilityRating: null,
    // SARIF has no native pass/fail gate — synthesize one so the dashboard
    // still has a clear signal: any high/critical finding fails the build.
    qualityGateStatus: findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'failed' : 'passed',
  };

  return { summary, findings };
}

module.exports = { parseSarifFile };
