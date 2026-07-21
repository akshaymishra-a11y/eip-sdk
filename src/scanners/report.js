const { createClient } = require('@supabase/supabase-js');

// Shared by all three scan parsers (sonarqube.js/sarif.js/npm-audit.js) —
// each one just produces { summary, findings }, and this turns that into
// one code_scan event plus one vulnerability event per finding, sent
// through the same ingest_events RPC everything else in this SDK uses. A
// scan report push is a one-shot CI step, not continuous telemetry, so
// there's no flush interval/buffering here — just send once and exit.
function createReporter({ apiKey, supabaseUrl, supabaseAnonKey }) {
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  async function send(events) {
    const filtered = events.filter(Boolean);
    if (!filtered.length) return;
    const { error } = await supabase.rpc('ingest_events', { p_api_key: apiKey, p_events: filtered });
    if (error) throw new Error(`failed to send scan report: ${error.message}`);
  }

  async function reportScan({ serviceName, tool, summary, findings }) {
    const occurredAt = new Date().toISOString();

    const events = [
      {
        kind: 'code_scan',
        payload: {
          service_name: serviceName,
          tool,
          quality_gate_status: summary.qualityGateStatus,
          bugs: summary.bugs,
          vulnerabilities: summary.vulnerabilities,
          code_smells: summary.codeSmells,
          security_hotspots: summary.securityHotspots,
          coverage: summary.coverage,
          duplicated_lines_density: summary.duplicatedLinesDensity,
          security_rating: summary.securityRating,
          reliability_rating: summary.reliabilityRating,
          maintainability_rating: summary.maintainabilityRating,
        },
        occurred_at: occurredAt,
      },
      ...findings.map((finding) => ({
        kind: 'vulnerability',
        payload: {
          service_name: serviceName,
          tool,
          severity: finding.severity,
          finding_type: finding.type,
          title: finding.title,
          description: finding.description,
          file_path: finding.filePath,
          line_number: finding.lineNumber,
          package_name: finding.packageName,
          package_version: finding.packageVersion,
          fixed_version: finding.fixedVersion,
          cve_id: finding.cveId,
        },
        occurred_at: occurredAt,
      })),
    ];

    // Supabase's PostgREST has a request body size limit — batch large
    // finding sets (a big SonarQube/SARIF run can produce thousands) rather
    // than sending everything in one call.
    const BATCH_SIZE = 200;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      await send(events.slice(i, i + BATCH_SIZE));
    }

    return { scanEventCount: 1, findingCount: findings.length };
  }

  return { reportScan };
}

module.exports = { createReporter };
