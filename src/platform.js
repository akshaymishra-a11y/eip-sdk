const fs = require('fs');

// Best-effort detection of the deployment platform a process is running
// under, using whatever identifying metadata that platform exposes locally.
// This only sees what *this process* can see about itself — it can't know
// about a sibling container that never started an eip-sdk process, or
// report on its own crash/OOM-kill after the fact. That's what the separate
// `eip watch` CLI (bin/eip-watch.js) is for: it polls the Docker/ECS/
// Kubernetes APIs directly and can see containers from the outside.

function detectDocker() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // ignore — fall through to the cgroup check
  }
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    if (/docker|containerd/.test(cgroup)) return true;
  } catch {
    // /proc doesn't exist on Windows/macOS hosts — not Docker, not an error
  }
  return false;
}

function dockerContainerId() {
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const match = cgroup.match(/[0-9a-f]{64}/);
    if (match) return match[0].slice(0, 12);
  } catch {
    // ignore
  }
  return null;
}

function kubernetesNamespace() {
  try {
    return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
  } catch {
    return process.env.POD_NAMESPACE || null;
  }
}

// ECS metadata needs an async HTTP call to the local metadata endpoint the
// ECS agent injects (ECS_CONTAINER_METADATA_URI_V4). detectDeployment()
// returns synchronously with platform: 'ecs' immediately — so the very
// first heartbeat is already correctly labeled — and this fills in the
// richer cluster/task fields in the background for the *next* heartbeat.
let ecsMetadataCache = null;
let ecsMetadataFetchStarted = false;
function fetchEcsMetadata(uri) {
  ecsMetadataFetchStarted = true;
  fetch(`${uri}/task`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      const container = data.Containers && data.Containers[0];
      ecsMetadataCache = {
        cluster_name: data.Cluster,
        orchestrator_ref: data.TaskARN,
        container_id: (container && container.DockerId) || null,
        image: container && container.Image,
      };
    })
    .catch(() => {
      // Metadata endpoint not reachable — heartbeats keep reporting
      // platform: 'ecs' with no extra fields rather than failing.
    });
}

function detectDeployment() {
  const ecsUri = process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI;
  if (ecsUri) {
    if (!ecsMetadataFetchStarted) fetchEcsMetadata(ecsUri);
    return { platform: 'ecs', ...(ecsMetadataCache || {}) };
  }
  if (process.env.KUBERNETES_SERVICE_HOST) {
    return {
      platform: 'kubernetes',
      orchestrator_ref: process.env.HOSTNAME || null, // pod name
      namespace: kubernetesNamespace(),
      // A k8s pod is still a container under the hood -- the same cgroup-based
      // lookup used for the 'docker' branch below works unchanged here, and
      // costs nothing extra since this whole function already only runs once
      // per heartbeat.
      container_id: dockerContainerId(),
    };
  }
  if (detectDocker()) {
    return {
      platform: 'docker',
      container_id: dockerContainerId() || process.env.HOSTNAME || null,
    };
  }
  return { platform: 'bare-metal' };
}

module.exports = { detectDeployment };
