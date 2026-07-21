#!/usr/bin/env node

// Run as a CI step right after a scan finishes — pushes a summary + findings
// to EIP via the same ingest_events pipeline everything else in this SDK
// uses. This is a one-shot report, not continuous telemetry: run it once
// per build/commit, it sends, and exits.
const { createReporter } = require('../src/scanners/report');
const { detectSonarConfig } = require('../src/sonar-detect');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sonarqube') {
      args.tool = 'sonarqube';
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      // Boolean-ish flags (no value follows, or the next token is itself a flag)
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function printUsage() {
  console.log(`
Usage: eip-scan-report --sonarqube|--sarif <file>|--npm-audit <file> [options]

Common (or set EIP_API_KEY / EIP_SUPABASE_URL / EIP_SUPABASE_ANON_KEY):
  --api-key <key>              EIP project API key
  --supabase-url <url>         Supabase project URL
  --supabase-anon-key <key>    Supabase anon key
  --service-name <name>        Service this scan belongs to (default: "default")

--sonarqube:
  --sonar-token <token>        SonarQube user token (required — never auto-detected, keep it out of version control)
  --sonar-url <url>            SonarQube server URL (auto-detected from sonar-project.properties/pom.xml/build.gradle if omitted)
  --project-key <key>          SonarQube project key (auto-detected the same way if omitted)

--sarif <file>:
  Path to a SARIF v2.1.0 JSON file (Trivy, Snyk, CodeQL, Semgrep, ESLint, Bandit, ...)

--npm-audit <file>:
  Path to \`npm audit --json\` output
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = args.apiKey || process.env.EIP_API_KEY;
  const supabaseUrl = args.supabaseUrl || process.env.EIP_SUPABASE_URL;
  const supabaseAnonKey = args.supabaseAnonKey || process.env.EIP_SUPABASE_ANON_KEY;

  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    console.error(
      '[eip-scan-report] --api-key/--supabase-url/--supabase-anon-key (or EIP_API_KEY/EIP_SUPABASE_URL/EIP_SUPABASE_ANON_KEY env vars) are required.'
    );
    process.exit(1);
  }

  let tool, summary, findings;
  if (args.tool === 'sonarqube') {
    tool = 'sonarqube';
    const detected = args.sonarUrl && args.projectKey ? null : detectSonarConfig();
    const sonarUrl = args.sonarUrl || detected?.hostUrl;
    const projectKey = args.projectKey || detected?.projectKey;
    if (!args.sonarToken || !sonarUrl || !projectKey) {
      console.error(
        '[eip-scan-report] --sonarqube requires --sonar-token always, plus --sonar-url/--project-key unless they can be auto-detected from sonar-project.properties/pom.xml/build.gradle in the current directory.'
      );
      process.exit(1);
    }
    if (detected) console.log(`[eip-scan-report] Auto-detected SonarQube project key "${detected.projectKey}" from the local repo.`);
    const { fetchSonarQubeReport } = require('../src/scanners/sonarqube');
    ({ summary, findings } = await fetchSonarQubeReport({ sonarUrl, token: args.sonarToken, projectKey }));
  } else if (args.sarif) {
    tool = 'sarif';
    const { parseSarifFile } = require('../src/scanners/sarif');
    ({ summary, findings } = parseSarifFile(args.sarif));
  } else if (args.npmAudit) {
    tool = 'npm-audit';
    const { parseNpmAuditFile } = require('../src/scanners/npm-audit');
    ({ summary, findings } = parseNpmAuditFile(args.npmAudit));
  } else {
    printUsage();
    process.exit(1);
  }

  const reporter = createReporter({ apiKey, supabaseUrl, supabaseAnonKey });
  const { findingCount } = await reporter.reportScan({
    serviceName: args.serviceName || 'default',
    tool,
    summary,
    findings,
  });

  console.log(
    `[eip-scan-report] Reported ${tool} scan: ${findingCount} finding(s), quality gate: ${summary.qualityGateStatus || 'n/a'}`
  );
}

main().catch((err) => {
  console.error('[eip-scan-report] fatal error:', err.message);
  process.exit(1);
});
