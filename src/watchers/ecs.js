// Structurally complete against the real AWS SDK, but not live-tested
// against a real ECS cluster in dev — there's no AWS account/credentials
// available in that environment. Verify against a real cluster before
// relying on this in production.
const POLL_INTERVAL_MS = 15000;

function requireEcsSdk() {
  try {
    return require('@aws-sdk/client-ecs');
  } catch {
    throw new Error('[eip-watch] --ecs requires @aws-sdk/client-ecs — install it with `npm install @aws-sdk/client-ecs` alongside eip-sdk.');
  }
}

async function watchEcs({ reporter, cluster, service, region }) {
  if (!cluster || !service) {
    throw new Error('[eip-watch] --ecs requires --cluster and --service');
  }
  const { ECSClient, DescribeServicesCommand, DescribeTasksCommand, ListTasksCommand } = requireEcsSdk();
  const client = new ECSClient(region ? { region } : undefined);

  // Fails fast with a clear message if credentials/cluster access are wrong,
  // instead of the poll loop silently retrying forever.
  await client.send(new DescribeServicesCommand({ cluster, services: [service] }));
  console.log(`[eip-watch] Connected to ECS, watching ${service}@${cluster}...`);

  let previousRunningCount = null;
  const lastKnownStatus = new Map(); // taskArn -> lastStatus, to detect STOPPED transitions

  async function poll() {
    const { services } = await client.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = services && services[0];
    if (!svc) return;

    const events = [];
    if (previousRunningCount !== null && svc.runningCount !== previousRunningCount) {
      events.push(
        reporter.containerEvent({
          serviceName: service,
          platform: 'ecs',
          containerId: null,
          eventType: svc.runningCount > previousRunningCount ? 'scale_up' : 'scale_down',
          reason: `running count ${previousRunningCount} -> ${svc.runningCount}`,
        })
      );
    }
    previousRunningCount = svc.runningCount;

    const { taskArns } = await client.send(new ListTasksCommand({ cluster, serviceName: service }));
    if (taskArns && taskArns.length) {
      const { tasks } = await client.send(new DescribeTasksCommand({ cluster, tasks: taskArns }));
      for (const task of tasks || []) {
        const previousStatus = lastKnownStatus.get(task.taskArn);
        if (previousStatus && previousStatus !== 'STOPPED' && task.lastStatus === 'STOPPED') {
          const oom = task.stoppedReason && /oom|out of memory/i.test(task.stoppedReason);
          events.push(
            reporter.containerEvent({
              serviceName: service,
              platform: 'ecs',
              containerId: task.taskArn,
              eventType: oom ? 'oom_kill' : 'die',
              reason: task.stoppedReason || null,
            })
          );
        }
        lastKnownStatus.set(task.taskArn, task.lastStatus);

        const primaryContainer = task.containers && task.containers[0];
        events.push(
          reporter.heartbeat({
            serviceName: service,
            deployment: {
              platform: 'ecs',
              cluster_name: cluster,
              orchestrator_ref: task.taskArn,
              image: primaryContainer && primaryContainer.image,
            },
          })
        );
      }
    }

    await reporter.send(events);
    console.log(`[eip-watch] ECS ${service}@${cluster}: ${svc.runningCount} running task(s)`);
  }

  await poll();
  const timer = setInterval(() => {
    poll().catch((err) => console.error('[eip-watch] ECS poll failed:', err.message));
  }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[eip-watch] Polling ECS every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);

  return () => clearInterval(timer);
}

module.exports = { watchEcs };
