const STATS_INTERVAL_MS = 10000;

// Docker reports far more event Actions than we track (exec_create,
// health_status, top, ...); anything not in this map is ignored.
const EVENT_TYPE_MAP = {
  start: 'start',
  die: 'die',
  stop: 'stop',
  restart: 'restart',
  oom: 'oom_kill',
};

function requireDockerode() {
  try {
    return require('dockerode');
  } catch {
    throw new Error('[eip-watch] --docker requires dockerode — install it with `npm install dockerode` alongside eip-sdk.');
  }
}

// Container Names come back as ["/my-container"] — strip the leading slash.
function containerServiceName(containerInfo) {
  const name = containerInfo.Names && containerInfo.Names[0];
  return name ? name.replace(/^\//, '') : containerInfo.Id.slice(0, 12);
}

function matchesLabelFilter(containerInfo, filter) {
  if (!filter) return true;
  const [key, value] = filter.split('=');
  return Boolean(containerInfo.Labels && containerInfo.Labels[key] === value);
}

// Docker doesn't report CPU% directly — this is the same delta-based
// calculation `docker stats` itself uses: change in container CPU time over
// change in total system CPU time, scaled by core count.
function computeStats(raw) {
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
  const cores = (raw.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0;

  return {
    cpuPercent,
    memoryUsedMb: raw.memory_stats.usage ? raw.memory_stats.usage / 1024 / 1024 : null,
    memoryTotalMb: raw.memory_stats.limit ? raw.memory_stats.limit / 1024 / 1024 : null,
    uptimeSeconds: null,
  };
}

async function watchDocker({ reporter, socketPath, labelFilter }) {
  const Docker = requireDockerode();
  const docker = new Docker(socketPath ? { socketPath } : undefined);

  // Fails fast with a clear message if the daemon/socket isn't reachable,
  // instead of the poll loop silently retrying forever.
  await docker.ping();
  console.log('[eip-watch] Connected to Docker engine, discovering containers...');

  async function reportContainerHeartbeat(containerInfo) {
    const serviceName = containerServiceName(containerInfo);
    let metrics = null;
    try {
      const container = docker.getContainer(containerInfo.Id);
      const raw = await container.stats({ stream: false });
      metrics = computeStats(raw);
    } catch (err) {
      console.error(`[eip-watch] failed to read stats for ${serviceName}:`, err.message);
    }

    await reporter.send([
      reporter.heartbeat({
        serviceName,
        deployment: {
          platform: 'docker',
          container_id: containerInfo.Id.slice(0, 12),
          image: containerInfo.Image,
        },
        metrics,
      }),
    ]);
  }

  async function pollAll() {
    const containers = await docker.listContainers({ all: false });
    const filtered = containers.filter((c) => matchesLabelFilter(c, labelFilter));
    await Promise.all(
      filtered.map((c) =>
        reportContainerHeartbeat(c).catch((err) => {
          console.error(`[eip-watch] failed to report ${containerServiceName(c)}:`, err.message);
        })
      )
    );
    console.log(`[eip-watch] Reported stats for ${filtered.length} container(s)`);
  }

  await pollAll();
  const timer = setInterval(() => {
    pollAll().catch((err) => console.error('[eip-watch] poll failed:', err.message));
  }, STATS_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  const eventStream = await docker.getEvents({ filters: JSON.stringify({ type: ['container'] }) });
  eventStream.on('data', (chunk) => {
    let event;
    try {
      event = JSON.parse(chunk.toString());
    } catch {
      return;
    }
    const eventType = EVENT_TYPE_MAP[event.Action];
    if (!eventType) return;

    // The Docker Engine API's /events stream identifies the container via
    // Actor.ID (Actor.Attributes for its name/exitCode/etc) — there's no
    // reliable top-level `id` field to fall back on across API versions.
    const containerId = event.Actor && event.Actor.ID;
    if (!containerId) return;

    const attributes = event.Actor.Attributes || {};
    const serviceName = attributes.name || containerId.slice(0, 12);
    const exitCode = attributes.exitCode;
    const reason = event.Action === 'die' && exitCode !== undefined && exitCode !== '0' ? `exit code ${exitCode}` : null;

    console.log(`[eip-watch] container event: ${serviceName} -> ${eventType}${reason ? ` (${reason})` : ''}`);
    reporter
      .send([
        reporter.containerEvent({
          serviceName,
          platform: 'docker',
          containerId: containerId.slice(0, 12),
          eventType,
          reason,
        }),
      ])
      .catch((err) => console.error('[eip-watch] failed to report event:', err.message));
  });

  console.log(`[eip-watch] Watching Docker events + polling stats every ${STATS_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);

  return () => {
    clearInterval(timer);
    eventStream.destroy();
  };
}

module.exports = { watchDocker };
