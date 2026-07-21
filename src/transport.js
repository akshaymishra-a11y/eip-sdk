// Returns whether the batch was actually delivered — callers (index.js's
// flush(), the watchers' reporter) use this to decide whether to requeue the
// events for the next attempt instead of silently discarding them.
//
// Backend migration (docs/NODEJS_BACKEND_MIGRATION_PLAN.md, Decision Point 1):
// when `apiUrl` is configured, events go to the NestJS ingestion endpoint
// (backend/src/ingestion) instead of the old `rest/v1/rpc/ingest_events`
// Supabase RPC. Same body shape (`{ p_api_key, p_events }`) either way, so
// this is purely a routing change, not a payload-format change. `apiUrl` is
// optional and falls back to the Supabase RPC path when unset, so existing
// deployments (or ones not yet pointed at a running Node backend) keep
// working unchanged.
async function sendEvents({ apiUrl, supabaseUrl, supabaseAnonKey, apiKey, events }) {
  if (!events || !events.length) return true;

  const { url, headers } = apiUrl
    ? { url: `${apiUrl.replace(/\/$/, '')}/api/telemetry/ingest`, headers: { 'Content-Type': 'application/json' } }
    : {
        url: `${supabaseUrl}/rest/v1/rpc/ingest_events`,
        headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
      };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_api_key: apiKey, p_events: events }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[eip-sdk] failed to send telemetry:', res.status, text);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[eip-sdk] failed to send telemetry:', err.message);
    return false;
  }
}

module.exports = { sendEvents };
