const fs = require('fs');
const { npmAuditSeverityToSeverity } = require('./severity');

// Parses `npm audit --json` output (npm 7+'s v2 report shape: an object
// keyed by package name under `vulnerabilities`, plus a `metadata.vulnerabilities`
// count summary). Older npm 6 reports use a different `advisories`-keyed
// shape and aren't supported here.
function parseNpmAuditFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = JSON.parse(raw);
  const vulnerabilities = doc.vulnerabilities || {};

  const findings = Object.entries(vulnerabilities).map(([packageName, entry]) => {
    // `via` mixes advisory objects (title/url/cve) with plain package-name
    // strings for transitive deps that only inherit the vulnerability —
    // the first advisory object is what carries a human-readable title/CVE.
    const advisory = (entry.via || []).find((v) => typeof v === 'object');
    // fixAvailable often points at a parent package needing a (sometimes
    // major) bump, not a new release of this exact package — e.g. fixing a
    // transitive `request` advisory by upgrading `@kubernetes/client-node`.
    // Naming which package to bump avoids implying `packageName` itself has
    // a same-named fixed release when it doesn't.
    const fix = entry.fixAvailable;
    const fixedVersion =
      fix && typeof fix === 'object' ? (fix.name && fix.name !== packageName ? `${fix.name}@${fix.version}` : fix.version) : null;

    return {
      severity: npmAuditSeverityToSeverity(entry.severity),
      type: 'dependency',
      title: (advisory && advisory.title) || `Vulnerable dependency: ${packageName}`,
      description: advisory && advisory.url ? advisory.url : null,
      filePath: null,
      lineNumber: null,
      packageName,
      packageVersion: entry.range || null,
      fixedVersion,
      cveId: advisory && advisory.cve ? advisory.cve : null,
    };
  });

  const counts = (doc.metadata && doc.metadata.vulnerabilities) || {};
  const totalVulnerabilities = counts.total ?? findings.length;
  const highOrCritical = (counts.high || 0) + (counts.critical || 0);

  const summary = {
    vulnerabilities: totalVulnerabilities,
    bugs: null,
    codeSmells: null,
    securityHotspots: null,
    coverage: null,
    duplicatedLinesDensity: null,
    securityRating: null,
    reliabilityRating: null,
    maintainabilityRating: null,
    // npm audit has no native pass/fail gate — synthesize one: any
    // high/critical advisory fails the build.
    qualityGateStatus: highOrCritical > 0 ? 'failed' : 'passed',
  };

  return { summary, findings };
}

module.exports = { parseNpmAuditFile };
