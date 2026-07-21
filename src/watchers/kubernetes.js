// Structurally complete against the real @kubernetes/client-node SDK, but
// not live-tested against a real cluster in dev — there's no Kubernetes
// cluster available in that environment. Verify against a real cluster
// before relying on this in production.
const POLL_INTERVAL_MS = 15000;

function requireK8sSdk() {
  try {
    return require('@kubernetes/client-node');
  } catch {
    throw new Error(
      '[eip-watch] --kubernetes requires @kubernetes/client-node — install it with `npm install @kubernetes/client-node` alongside eip-sdk.'
    );
  }
}

async function watchKubernetes({ reporter, namespace }) {
  const k8s = requireK8sSdk();
  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromDefault();
  const api = kubeConfig.makeApiClient(k8s.CoreV1Api);

  const ns = namespace || 'default';

  // Fails fast with a clear message if the cluster/kubeconfig is wrong,
  // instead of the poll loop silently retrying forever.
  await api.listNamespacedPod(ns);
  console.log(`[eip-watch] Connected to Kubernetes, watching namespace "${ns}"...`);

  const lastKnownRestartCount = new Map(); // pod name -> total restart count, to detect new restarts

  async function poll() {
    const { body } = await api.listNamespacedPod(ns);
    const events = [];

    for (const pod of body.items) {
      const podName = pod.metadata.name;
      const containerStatuses = pod.status.containerStatuses || [];
      const restartCount = containerStatuses.reduce((sum, s) => sum + (s.restartCount || 0), 0);

      const previousCount = lastKnownRestartCount.get(podName);
      if (previousCount !== undefined && restartCount > previousCount) {
        const oomKilled = containerStatuses.some(
          (s) => s.lastState && s.lastState.terminated && s.lastState.terminated.reason === 'OOMKilled'
        );
        events.push(
          reporter.containerEvent({
            serviceName: podName,
            platform: 'kubernetes',
            containerId: pod.metadata.uid,
            eventType: oomKilled ? 'oom_kill' : 'restart',
            reason: oomKilled ? 'OOMKilled' : `restart count ${previousCount} -> ${restartCount}`,
          })
        );
      }
      lastKnownRestartCount.set(podName, restartCount);

      const primaryContainer = pod.spec.containers && pod.spec.containers[0];
      events.push(
        reporter.heartbeat({
          serviceName: podName,
          deployment: {
            platform: 'kubernetes',
            orchestrator_ref: podName,
            namespace: ns,
            container_id: pod.metadata.uid,
            image: primaryContainer && primaryContainer.image,
          },
        })
      );
    }

    await reporter.send(events);
    console.log(`[eip-watch] Kubernetes namespace "${ns}": ${body.items.length} pod(s)`);
  }

  await poll();
  const timer = setInterval(() => {
    poll().catch((err) => console.error('[eip-watch] Kubernetes poll failed:', err.message));
  }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[eip-watch] Polling Kubernetes every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);

  return () => clearInterval(timer);
}

module.exports = { watchKubernetes };
