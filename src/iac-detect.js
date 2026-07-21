const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Zero-config Infrastructure-as-Code discovery: scans the same working
// directory as pipeline-detect.js (process.cwd()) for Terraform resources
// and Kubernetes/Helm manifests. Same "best-effort, per-source try/catch"
// philosophy — one malformed file can't break heartbeat reporting.
//
// Deliberately does not infer relationships between manifests (e.g. a
// Service's label selector matching a Deployment's pods, for a real
// topology diagram) — that's a distinct, harder problem left for later,
// same kind of scoping call already made for cross-service distributed
// tracing in sdk/src/index.js. This is discovery/listing, not topology.

// Filenames pipeline-detect.js already claims as CI/compose config — a repo
// can have plain YAML files sitting anywhere, so those exact names are
// excluded here to avoid double-reporting a CI file as a Kubernetes manifest
// (in practice this rarely matters since compose/CI files have neither
// `apiVersion` nor `kind`, but excluding by name is a cheap extra safety net).
const CLAIMED_BY_PIPELINE_DETECT = new Set([
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
]);

const TERRAFORM_CATEGORY_PREFIXES = [
  ['aws_vpc', 'vpc'],
  ['aws_subnet', 'vpc'],
  ['aws_ecs', 'ecs'],
  ['aws_eks', 'eks'],
  ['aws_db_instance', 'rds'],
  ['aws_rds', 'rds'],
  ['aws_lb', 'alb'],
  ['aws_alb', 'alb'],
  ['aws_security_group', 'security_group'],
];

function categorizeTerraformType(type) {
  const match = TERRAFORM_CATEGORY_PREFIXES.find(([prefix]) => type.startsWith(prefix));
  return match ? match[1] : 'other';
}

function detectTerraform(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.tf'));
  } catch {
    return [];
  }

  const resources = [];
  const resourceRegex = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      let match;
      while ((match = resourceRegex.exec(text))) {
        const [, type, name] = match;
        resources.push({
          source: 'terraform',
          source_file: file,
          resource_type: type,
          resource_category: categorizeTerraformType(type),
          resource_name: name,
          namespace: null,
          metadata: null,
        });
      }
    } catch {
      // skip unreadable .tf file
    }
  }
  return resources;
}

function detectKubernetesManifests(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f) && !CLAIMED_BY_PIPELINE_DETECT.has(f));
  } catch {
    return [];
  }

  const resources = [];
  for (const file of files) {
    try {
      const docs = yaml.loadAll(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const doc of docs) {
        if (!doc || typeof doc !== 'object' || !doc.apiVersion || !doc.kind) continue;
        resources.push({
          source: 'kubernetes',
          source_file: file,
          resource_type: doc.kind,
          resource_category: null,
          resource_name: doc.metadata?.name || 'unnamed',
          namespace: doc.metadata?.namespace || 'default',
          metadata: null,
        });
      }
    } catch {
      // skip files that aren't valid YAML (or aren't K8s manifests at all)
    }
  }
  return resources;
}

// Only detects the presence of a Helm chart (Chart.yaml) — template files
// under templates/ contain unresolved `{{ }}` Go-template syntax and aren't
// valid YAML on their own, so they're never parsed.
function detectHelmChart(dir) {
  const file = 'Chart.yaml';
  try {
    const doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!doc || typeof doc !== 'object' || !doc.name) return null;
    return {
      source: 'helm',
      source_file: file,
      resource_type: 'helm_chart',
      resource_category: null,
      resource_name: doc.name,
      namespace: null,
      metadata: { version: doc.version || null, appVersion: doc.appVersion || null },
    };
  } catch {
    return null;
  }
}

function detectInfraResources(cwd = process.cwd()) {
  const resources = [...detectTerraform(cwd), ...detectKubernetesManifests(cwd)];
  const helmChart = detectHelmChart(cwd);
  if (helmChart) resources.push(helmChart);
  return { resources };
}

module.exports = { detectInfraResources };
