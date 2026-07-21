const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Zero-config CI/CD + container discovery: scans the CI config and
// Docker/compose files that already live in the repo the SDK is running
// from (process.cwd()) so a pipeline's *structure* (what stages/services
// exist) shows up without any token or integration setup — complementary to
// the GitHub-API-based poll-github-repo Edge Function, which reports real
// *run history* (status/duration/actor) but only for GitHub Actions and only
// once someone configures a PAT. Same "best-effort, no per-format parser
// dependency" philosophy as sonar-detect.js: every source is wrapped in its
// own try/catch so one malformed file can't break heartbeat reporting.

function safeReadYaml(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return yaml.load(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function stagesFromOrder(names) {
  return names.map((name, order) => ({ name: String(name), order }));
}

// GitHub Actions: one workflow file = one pipeline, jobs = stages. Object
// key order is preserved by js-yaml/V8 for string keys, which is close
// enough to declaration order for a diagram (the GitHub API integration is
// the source of truth for actual execution order/status).
function detectGithubActions(dir) {
  const workflowsDir = path.join(dir, '.github', 'workflows');
  let files;
  try {
    files = fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    return [];
  }

  const results = [];
  for (const file of files) {
    try {
      const doc = yaml.load(fs.readFileSync(path.join(workflowsDir, file), 'utf8'));
      if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') continue;
      results.push({
        provider: 'github_actions',
        file_path: path.join('.github', 'workflows', file).replace(/\\/g, '/'),
        name: doc.name || file,
        stages: stagesFromOrder(Object.keys(doc.jobs)),
      });
    } catch {
      // skip malformed workflow file
    }
  }
  return results;
}

const GITLAB_RESERVED_KEYS = new Set([
  'stages',
  'variables',
  'include',
  'workflow',
  'default',
  'image',
  'services',
  'before_script',
  'after_script',
  'cache',
]);

// GitLab CI's own `stages:` list is the ground truth when present (see the
// csat/.gitlab-ci.yml fixture: `stages: [build, deploy]`) — only falls back
// to deriving unique `stage:` values off each job when a repo relies on
// GitLab's implicit default stages instead of declaring them.
function detectGitlabCi(dir) {
  const filePath = '.gitlab-ci.yml';
  const doc = safeReadYaml(path.join(dir, filePath));
  if (!doc || typeof doc !== 'object') return [];

  let stageNames;
  if (Array.isArray(doc.stages) && doc.stages.length > 0) {
    stageNames = doc.stages;
  } else {
    stageNames = [];
    for (const [key, value] of Object.entries(doc)) {
      if (key.startsWith('.') || GITLAB_RESERVED_KEYS.has(key)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const stage = value.stage || 'test'; // GitLab's implicit default stage
      if (!stageNames.includes(stage)) stageNames.push(stage);
    }
  }
  if (stageNames.length === 0) return [];
  return [{ provider: 'gitlab_ci', file_path: filePath, name: 'GitLab CI', stages: stagesFromOrder(stageNames) }];
}

function detectAzurePipelines(dir) {
  const filePath = 'azure-pipelines.yml';
  const doc = safeReadYaml(path.join(dir, filePath));
  if (!doc || typeof doc !== 'object') return [];

  let stageNames = [];
  if (Array.isArray(doc.stages)) {
    stageNames = doc.stages.map((s, i) => (s && typeof s === 'object' ? s.stage || s.displayName : null) || `stage-${i + 1}`);
  } else if (Array.isArray(doc.jobs)) {
    stageNames = doc.jobs.map((j, i) => (j && typeof j === 'object' ? j.job || j.displayName : null) || `job-${i + 1}`);
  } else if (Array.isArray(doc.steps)) {
    stageNames = ['pipeline'];
  }
  if (stageNames.length === 0) return [];
  return [{ provider: 'azure_pipelines', file_path: filePath, name: 'Azure Pipelines', stages: stagesFromOrder(stageNames) }];
}

function detectCircleCi(dir) {
  const filePath = path.join('.circleci', 'config.yml').replace(/\\/g, '/');
  const doc = safeReadYaml(path.join(dir, filePath));
  if (!doc || typeof doc !== 'object') return [];

  let stageNames = [];
  if (doc.workflows && typeof doc.workflows === 'object') {
    for (const [key, workflow] of Object.entries(doc.workflows)) {
      if (key === 'version' || !workflow || typeof workflow !== 'object' || !Array.isArray(workflow.jobs)) continue;
      stageNames = workflow.jobs.map((j) => (typeof j === 'string' ? j : Object.keys(j)[0]));
      break;
    }
  }
  if (stageNames.length === 0 && doc.jobs && typeof doc.jobs === 'object') {
    stageNames = Object.keys(doc.jobs);
  }
  if (stageNames.length === 0) return [];
  return [{ provider: 'circleci', file_path: filePath, name: 'CircleCI', stages: stagesFromOrder(stageNames) }];
}

function collectBitbucketStepNames(steps, fallbackPrefix) {
  const names = [];
  for (const entry of steps || []) {
    if (entry && typeof entry === 'object' && entry.step) {
      names.push(entry.step.name || `${fallbackPrefix}-${names.length + 1}`);
    } else if (entry && typeof entry === 'object' && entry.parallel) {
      const parallelSteps = Array.isArray(entry.parallel) ? entry.parallel : entry.parallel.steps;
      names.push(...collectBitbucketStepNames(parallelSteps, fallbackPrefix));
    }
  }
  return names;
}

function detectBitbucketPipelines(dir) {
  const filePath = 'bitbucket-pipelines.yml';
  const doc = safeReadYaml(path.join(dir, filePath));
  if (!doc || typeof doc !== 'object' || !doc.pipelines || typeof doc.pipelines !== 'object') return [];

  let steps = doc.pipelines.default;
  if (!Array.isArray(steps) && doc.pipelines.branches && typeof doc.pipelines.branches === 'object') {
    const firstBranch = Object.values(doc.pipelines.branches)[0];
    if (Array.isArray(firstBranch)) steps = firstBranch;
  }
  if (!Array.isArray(steps)) return [];

  const stageNames = collectBitbucketStepNames(steps, 'step');
  if (stageNames.length === 0) return [];
  return [{ provider: 'bitbucket_pipelines', file_path: filePath, name: 'Bitbucket Pipelines', stages: stagesFromOrder(stageNames) }];
}

// Jenkinsfiles are Groovy, not YAML — same "best-effort regex, no
// Groovy/XML parser dependency" approach sonar-detect.js already uses for
// pom.xml/build.gradle. Matches Declarative Pipeline's `stage('Name') { ... }`
// blocks in file order.
function detectJenkinsfile(dir) {
  const filePath = 'Jenkinsfile';
  const full = path.join(dir, filePath);
  if (!fs.existsSync(full)) return [];
  try {
    const text = fs.readFileSync(full, 'utf8');
    const stageNames = [];
    const stageRegex = /stage\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = stageRegex.exec(text))) stageNames.push(match[1]);
    if (stageNames.length === 0) return [];
    return [{ provider: 'jenkins', file_path: filePath, name: 'Jenkins Pipeline', stages: stagesFromOrder(stageNames) }];
  } catch {
    return [];
  }
}

// A bare Dockerfile's multi-stage `FROM <image> AS <name>` lines are Docker's
// own literal build stages (see the csat/Dockerfile fixture: base -> deps ->
// builder -> prod-deps -> runtime) — reported as one container definition
// named 'app' since a standalone Dockerfile has no service name of its own
// (unlike compose, which names each service explicitly).
function detectDockerfile(dir) {
  const filePath = 'Dockerfile';
  const full = path.join(dir, filePath);
  if (!fs.existsSync(full)) return null;
  try {
    const text = fs.readFileSync(full, 'utf8');
    const buildStages = [];
    const stageImageByName = new Map(); // stage name (lowercased) -> the image/alias it was declared FROM
    const fromRegex = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim;
    let match;
    let lastImage = null;
    while ((match = fromRegex.exec(text))) {
      lastImage = match[1];
      if (match[2]) {
        buildStages.push({ name: match[2], base_image: match[1] });
        stageImageByName.set(match[2].toLowerCase(), match[1]);
      }
    }
    if (!lastImage) return null;

    // Multi-stage builds often re-use an earlier stage as the final FROM
    // (e.g. `FROM base AS runtime` where `base` is itself `FROM node:18-slim
    // AS base` — see csat/Dockerfile) — walk that alias chain back to the
    // real external base image rather than reporting an internal stage name.
    let resolvedImage = lastImage;
    for (let i = 0; i < buildStages.length && stageImageByName.has(resolvedImage.toLowerCase()); i++) {
      resolvedImage = stageImageByName.get(resolvedImage.toLowerCase());
    }

    const ports = [];
    const exposeRegex = /^\s*EXPOSE\s+(.+)$/gim;
    while ((match = exposeRegex.exec(text))) ports.push(...match[1].trim().split(/\s+/));

    return {
      source_file: filePath,
      container_name: 'app',
      image: resolvedImage,
      build_stages: buildStages.length > 0 ? buildStages : null,
      ports: ports.length > 0 ? ports : null,
      depends_on: null,
      volumes: null,
    };
  } catch {
    return null;
  }
}

function detectComposeFile(dir) {
  const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const filePath of candidates) {
    const doc = safeReadYaml(path.join(dir, filePath));
    if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') continue;

    const containers = [];
    for (const [name, svc] of Object.entries(doc.services)) {
      if (!svc || typeof svc !== 'object') continue;
      let dependsOn = null;
      if (Array.isArray(svc.depends_on)) dependsOn = svc.depends_on;
      else if (svc.depends_on && typeof svc.depends_on === 'object') dependsOn = Object.keys(svc.depends_on);

      containers.push({
        source_file: filePath,
        container_name: name,
        image: svc.image || (svc.build ? `build:${typeof svc.build === 'string' ? svc.build : svc.build.context || '.'}` : null),
        build_stages: null,
        ports: Array.isArray(svc.ports) ? svc.ports.map(String) : null,
        depends_on: dependsOn,
        volumes: Array.isArray(svc.volumes) ? svc.volumes.map(String) : null,
      });
    }
    // First matching compose file wins — real repos have at most one at the root.
    if (containers.length > 0) return containers;
  }
  return [];
}

function detectPipelines(cwd = process.cwd()) {
  const pipelines = [
    ...detectGithubActions(cwd),
    ...detectGitlabCi(cwd),
    ...detectAzurePipelines(cwd),
    ...detectCircleCi(cwd),
    ...detectBitbucketPipelines(cwd),
    ...detectJenkinsfile(cwd),
  ];

  const containers = [];
  const dockerfileContainer = detectDockerfile(cwd);
  if (dockerfileContainer) containers.push(dockerfileContainer);
  containers.push(...detectComposeFile(cwd));

  return { pipelines, containers };
}

module.exports = { detectPipelines };
