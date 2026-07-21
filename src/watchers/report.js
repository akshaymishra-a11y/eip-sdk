const { createClient } = require('@supabase/supabase-js');

// Shared by all three platform watchers (docker.js/ecs.js/kubernetes.js) —
// they only ever need to build heartbeat/container_event payloads and send
// a batch, so this is the one place that talks to Supabase directly. Same
// ingest_events RPC the in-process SDK uses; a watcher is really just an
// eip-sdk client reporting on behalf of containers it can see but that
// aren't running an SDK of their own.
function createReporter({ apiKey, supabaseUrl, supabaseAnonKey, maxBufferedEvents = 2000 }) {
  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  // A watcher builds a fresh events array each poll rather than keeping a
  // running buffer — on a failed send, this is where that batch waits to be
  // retried alongside next poll's events, instead of being dropped outright.
  let pending = [];
  let droppedEventCount = 0;

  async function send(events) {
    const filtered = (events || []).filter(Boolean);
    const toSend = pending.concat(filtered);
    if (!toSend.length) return;
    const { error } = await supabase.rpc('ingest_events', { p_api_key: apiKey, p_events: toSend });
    if (error) {
      console.error('[eip-watch] failed to send telemetry:', error.message);
      if (toSend.length > maxBufferedEvents) {
        droppedEventCount += toSend.length - maxBufferedEvents;
        pending = toSend.slice(toSend.length - maxBufferedEvents);
      } else {
        pending = toSend;
      }
      return;
    }
    pending = [];
    if (droppedEventCount > 0) {
      console.error(`[eip-watch] telemetry delivery recovered — ${droppedEventCount} event(s) were dropped while it was down.`);
      droppedEventCount = 0;
    }
  }

  function heartbeat({ serviceName, serviceType, deployment, metrics }) {
    return {
      kind: 'heartbeat',
      payload: {
        service_name: serviceName,
        service_type: serviceType || 'application',
        deployment,
        cpu_percent: metrics ? metrics.cpuPercent : undefined,
        memory_used_mb: metrics ? metrics.memoryUsedMb : undefined,
        memory_total_mb: metrics ? metrics.memoryTotalMb : undefined,
        uptime_seconds: metrics ? metrics.uptimeSeconds : undefined,
      },
      occurred_at: new Date().toISOString(),
    };
  }

  function containerEvent({ serviceName, platform, containerId, eventType, reason }) {
    return {
      kind: 'container_event',
      payload: {
        service_name: serviceName,
        platform,
        container_id: containerId,
        event_type: eventType,
        reason,
      },
      occurred_at: new Date().toISOString(),
    };
  }

  return { send, heartbeat, containerEvent };
}

module.exports = { createReporter };
