const Module = require('module');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { detectHost } = require('./detect');
const { detectDeployment } = require('./platform');
const { detectSonarConfig } = require('./sonar-detect');
const { detectPipelines } = require('./pipeline-detect');
const { detectInfraResources } = require('./iac-detect');
const { detectMigrations } = require('./migration-detect');
const { createMetricsSampler } = require('./collector');
const { sendEvents } = require('./transport');
const { locateErrorSource } = require('./stacktrace');
const { createRedactor } = require('./redact');
const { generateTraceId, generateSpanId, extractIncomingContext, buildOutgoingHeaders } = require('./trace-context');
const { parseSqlContext } = require('./sql-context');
const { resolveOriginalPosition } = require('./sourcemap');

// The SDK's own source directory — stack frames pointing in here are
// telemetry-capture plumbing, never the app's own bug, so error-location
// lookups skip past them the same way they skip node_modules.
const SDK_DIR = __dirname;

// Reduces a raw Error.stack to the three fields a human actually wants when
// jumping into their editor: which function, which file, which line. Returns
// nulls (not throwing/omitting) when the stack is missing or unparseable, so
// callers can always spread this into a payload unconditionally.
//
// `sourceMaps` (Error Intelligence Phase 2, Tier 2.4) opts into de-minifying
// the located frame via sourcemap.js's resolveOriginalPosition() when a
// `<file>.map` sits next to the frame's file on disk — off by default since
// it's a sync disk read on the error hot path, only worth it for apps
// shipping bundled/minified code.
function errorLocationFields(stack, sourceMaps) {
  const location = locateErrorSource(stack, SDK_DIR);
  if (location && sourceMaps) {
    const original = resolveOriginalPosition(location.file, location.line, location.column);
    if (original) {
      return {
        source_file: original.file,
        source_line: original.line,
        source_function: original.function || location.function,
      };
    }
  }
  return {
    source_file: location ? location.file : null,
    source_line: location ? location.line : null,
    source_function: location ? location.function : null,
  };
}

// Holds { traceId, spanId, sampled, baggage } for the span currently "in
// scope" — set once per inbound request (see middleware()/fastifyPlugin()/
// the NestJS adapter in nestjs.js) and read by wrapDatabase()/logger/outgoing
// HTTP instrumentation so DB spans, logs, and cross-service calls can all be
// attributed to the request that caused them. As of Error Intelligence Phase
// 1, `traceId`/`spanId` are real W3C Trace Context ids (see trace-context.js)
// propagated over the wire via `traceparent`/`baggage` headers on every
// outgoing fetch/axios call — so a trace now spans multiple services, not
// just this one process's internal call graph.
const traceContext = new AsyncLocalStorage();

const CONSOLE_LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

// Renders console.log/warn/error-style arguments (strings, objects, Errors)
// into one message string, the same shape a human would see printed.
function formatConsoleArgs(args) {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ')
    .slice(0, 2000);
}

// Names auto-instrumentation recognizes when the host app require()s them —
// deliberately the same package names detect.js scans package.json for, so
// "what Architecture View discovered" and "what actually gets instrumented"
// stay in sync. node-redis (the `redis` package) isn't included: unlike
// ioredis it doesn't expose a simple class prototype to patch, so it still
// needs a manual wrapCache() call. `mongoose` is also excluded — it wraps
// `mongodb` with its own separate Model/Schema layer that doesn't go through
// Collection.prototype, so instrumenting `mongodb` doesn't reach it.
const AUTO_INSTRUMENT_MODULES = ['pg', 'mysql2', 'mysql2/promise', 'ioredis', 'axios', 'mongodb'];

let requireHookInstalled = false;

function init(options) {
  const {
    apiKey,
    // Backend migration (docs/NODEJS_BACKEND_MIGRATION_PLAN.md): set apiUrl
    // to point telemetry at the NestJS ingestion endpoint instead of
    // Supabase directly. supabaseUrl/supabaseAnonKey become optional once
    // apiUrl is set (see the requiredness check below) — they're only used
    // as the ingestion transport's fallback when apiUrl is absent.
    apiUrl,
    supabaseUrl,
    supabaseAnonKey,
    serviceName = 'default',
    flushIntervalMs = 10000,
    captureConsole = true,
    autoInstrument = true,
    redactSecrets = true,
    // Safety valve for a prolonged outage: without this, a failed send would
    // either drop its batch outright (silent data loss) or requeue forever
    // with nothing capping memory growth. 5000 events is generous for one
    // process's 10s-flush buffer while still being a hard ceiling.
    maxBufferedEvents = 5000,
    // Error Intelligence Phase 1 (P0) additions — all optional, all
    // backward-compatible (nullable, no behavior change when unset), so an
    // SDK upgrade with none of these configured keeps working exactly as
    // before.
    release,
    environment,
    redactionDenylist = [],
    redactionAllowlist = [],
    captureHeaders = true,
    captureRequestBody = false,
    captureQueryParams = true,
    // Error Intelligence Phase 2 (Tier 2) additions — also optional/
    // backward-compatible. tracesSampleRate=1 (capture every trace) matches
    // this SDK's pre-sampling behavior exactly, so an upgrade with none of
    // this configured keeps working as before. sourceMaps=false since
    // resolving a .map file is a sync disk read on the error hot path —
    // only worth it for apps that actually ship bundled/minified code.
    tracesSampleRate = 1,
    sourceMaps = false,
    // Sprint 4 (docs/optimization_plan.md) — caps a single log message's
    // serialized size the same way headers/request_body/query_params are
    // already capped (see MAX_CAPTURED_FIELD_JSON_LENGTH below).
    maxLogSizeBytes = 4096,
    // Bounds the SIGTERM/SIGINT flush below — a Kubernetes pod's termination
    // grace period is commonly 30s, but this must stay well under that so a
    // stalled/unreachable backend can't eat into the time the app itself
    // needs to drain in-flight requests before SIGKILL lands.
    shutdownTimeoutMs = 3000,
  } = options || {};

  if (!apiKey) throw new Error('[eip-sdk] init() requires an apiKey');
  if (!apiUrl) {
    if (!supabaseUrl) throw new Error('[eip-sdk] init() requires a supabaseUrl (or apiUrl)');
    if (!supabaseAnonKey) throw new Error('[eip-sdk] init() requires a supabaseAnonKey (or apiUrl)');
  }

  const host = detectHost();

  // Fallback chains so a zero-config upgrade still reports *something*
  // useful when the host environment (CI, k8s downward API) already carries
  // this information — explicit `release`/`environment` config always wins.
  const releaseVersion = (release && release.version) || process.env.EIP_RELEASE_VERSION || process.env.npm_package_version || undefined;
  const releaseCommitSha =
    (release && release.commitSha) || process.env.EIP_RELEASE_COMMIT_SHA || process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || undefined;
  const releaseBranch =
    (release && release.branch) || process.env.EIP_RELEASE_BRANCH || process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_REF_NAME || undefined;
  const resolvedEnvironment = environment || process.env.EIP_ENVIRONMENT || host.env || undefined;

  const redactor = createRedactor({ denylist: redactionDenylist, allowlist: redactionAllowlist });
  // Static like `host` (re-read from disk once, not per-flush like
  // `deployment`) — a repo's sonar-project.properties/pom.xml/build.gradle
  // doesn't change while the process is running. Lets the Integrations UI
  // suggest a SonarQube project key instead of requiring it typed by hand.
  const sonar = detectSonarConfig();
  // Same rationale as `sonar` above: CI config and Docker/compose files
  // don't change while the process is running, so this is scanned once here
  // rather than per-flush. See sdk/src/pipeline-detect.js.
  const { pipelines, containers } = detectPipelines();
  // Same rationale — Terraform/Kubernetes/Helm files don't change while the
  // process is running either. See sdk/src/iac-detect.js.
  const { resources: infraResources } = detectInfraResources();
  // Same rationale again — migration files already on disk at process start
  // don't change while the process is running. See sdk/src/migration-detect.js.
  const migrations = detectMigrations();
  const sampleMetrics = createMetricsSampler();
  let buffer = [];
  let droppedEventCount = 0;
  // Refreshed every flush() tick (see below) — cached here so error-time
  // infra correlation never has to re-detect the deployment platform
  // synchronously on the error hot path.
  let lastDeployment = null;

  // A single choke point for every event kind that can carry free-text or
  // structured request data — db_query (query_text/error_message), error
  // (message/stack/headers/request_body/query_params), and log
  // (message/metadata) — rather than redacting at each of their call sites.
  function redactedPayload(payload) {
    const result = { ...payload };
    if (typeof result.query_text === 'string') result.query_text = redactor.redactText(result.query_text);
    if (typeof result.message === 'string') result.message = redactor.redactText(result.message);
    if (typeof result.stack === 'string') result.stack = redactor.redactText(result.stack);
    if (typeof result.error_message === 'string') result.error_message = redactor.redactText(result.error_message);
    if (result.metadata) result.metadata = redactor.redactObject(result.metadata);
    if (result.headers) result.headers = redactor.redactHeaders(result.headers);
    if (result.request_body) result.request_body = redactor.redactObject(result.request_body);
    if (result.query_params) result.query_params = redactor.redactObject(result.query_params);
    return result;
  }

  function pushEvent(kind, payload) {
    const finalPayload = redactSecrets ? redactedPayload(payload) : payload;
    buffer.push({
      kind,
      payload: {
        service_name: serviceName,
        release_version: releaseVersion,
        release_commit_sha: releaseCommitSha,
        release_branch: releaseBranch,
        environment: resolvedEnvironment,
        ...finalPayload,
      },
      occurred_at: new Date().toISOString(),
    });
  }

  // k8s pod_name/node_name come from the standard downward-API env vars (no
  // @kubernetes/client-node in the hot path — see README) with a fallback to
  // whatever the deployment detector already inferred from HOSTNAME. Shared
  // by currentInfraSnapshot() (error hot path) and flush()'s heartbeat, so a
  // running service's identity fields are computed identically everywhere
  // they're reported instead of drifting between the two call sites.
  //
  // Platform-specific fields are branched explicitly rather than merged —
  // `deployment.orchestrator_ref` means a *pod name* on Kubernetes but a
  // *Task ARN* on ECS (see platform.js's detectDeployment()); collapsing
  // both into one `pod_name` column mislabeled ECS data as Kubernetes data
  // and silently dropped the ECS cluster name entirely.
  function deploymentIdentityFields(deployment) {
    const fields = {
      container_id: deployment.container_id || null,
      pod_name: null,
      node_name: null,
      namespace: null,
      ecs_task_arn: null,
      ecs_cluster_name: null,
    };
    if (deployment.platform === 'ecs') {
      fields.ecs_task_arn = deployment.orchestrator_ref || null;
      fields.ecs_cluster_name = deployment.cluster_name || null;
    } else if (deployment.platform === 'kubernetes') {
      fields.pod_name = process.env.POD_NAME || deployment.orchestrator_ref || null;
      fields.node_name = process.env.NODE_NAME || null;
      fields.namespace = deployment.namespace || process.env.POD_NAMESPACE || null;
    }
    return fields;
  }

  // Cheap, synchronous, zero-syscall snapshot of infra state for the error
  // hot path — see createMetricsSampler()'s peek()/sample() split in
  // collector.js for why this must never call sample() directly.
  function currentInfraSnapshot() {
    const metrics = sampleMetrics.peek() || {};
    const deployment = lastDeployment || {};
    return {
      cpu_percent: metrics.cpu_percent ?? null,
      memory_used_mb: metrics.memory_used_mb ?? null,
      memory_total_mb: metrics.memory_total_mb ?? null,
      event_loop_lag_ms: metrics.event_loop_lag_ms ?? null,
      hostname: host.hostname,
      ...deploymentIdentityFields(deployment),
    };
  }

  // Size cap on serialized headers/request_body/query_params — mirrors the
  // existing 300-char query_text truncation, protecting ingestion payload
  // size even after redaction has already run.
  const MAX_CAPTURED_FIELD_JSON_LENGTH = 4000;
  function capField(value) {
    if (value === undefined) return undefined;
    try {
      const json = JSON.stringify(value);
      return json.length > MAX_CAPTURED_FIELD_JSON_LENGTH ? { truncated: true, preview: json.slice(0, MAX_CAPTURED_FIELD_JSON_LENGTH) } : value;
    } catch {
      return undefined;
    }
  }

  // Splits a raw path+query URL into a redaction-friendly shape: `endpoint`
  // stays path-only, the query string moves into its own independently
  // redactable field. Fixes a small pre-existing leak — `endpoint` used to be
  // `req.originalUrl` verbatim, which carried the raw, unredacted query
  // string straight into telemetry (e.g. `?token=abc123`).
  function splitUrl(rawUrl) {
    if (!rawUrl) return { path: undefined, query: undefined };
    const qIndex = rawUrl.indexOf('?');
    if (qIndex === -1) return { path: rawUrl, query: undefined };
    const path_ = rawUrl.slice(0, qIndex);
    const query = {};
    new URLSearchParams(rawUrl.slice(qIndex + 1)).forEach((value, key) => {
      query[key] = value;
    });
    return { path: path_, query };
  }

  // Single consolidated error-capture path — every capture site (Express
  // errorHandler, Fastify's setErrorHandler, uncaughtException,
  // unhandledRejection, captureConsoleOutput, and the NestJS exception
  // filter in nestjs.js) funnels through here, so trace ids, infra
  // snapshot, and release/redaction all only had to be wired up once.
  // `extra` carries request-shaped context, all optional:
  //   { endpoint, headers, requestBody, queryParams, defaultName, message }
  function captureException(err, extra) {
    const opts = extra || {};
    const ctx = traceContext.getStore();
    const { path: endpointPath, query: endpointQuery } = splitUrl(opts.endpoint);
    pushEvent('error', {
      error_name: (err && err.name) || opts.defaultName || 'Error',
      message: opts.message || (err && err.message),
      stack: err && err.stack,
      endpoint: endpointPath,
      query_params: captureQueryParams ? opts.queryParams || endpointQuery : undefined,
      headers: captureHeaders ? capField(opts.headers) : undefined,
      request_body: captureRequestBody ? capField(opts.requestBody) : undefined,
      ...errorLocationFields(err && err.stack, sourceMaps),
      ...currentInfraSnapshot(),
      trace_id: ctx ? ctx.traceId : null,
      span_id: ctx ? ctx.spanId : null,
      end_user_id: ctx && ctx.user ? ctx.user.id ?? null : null,
      end_user_email: ctx && ctx.user ? ctx.user.email ?? null : null,
    });
  }

  async function flush() {
    const metrics = sampleMetrics.sample();
    // Re-detected every flush (not cached alongside `host`) because ECS
    // metadata resolves asynchronously in the background — an early
    // heartbeat may only have `platform: 'ecs'`, with cluster/task filled
    // in once fetchEcsMetadata() finishes for a later one. Cached into
    // `lastDeployment` for currentInfraSnapshot()'s error-time use.
    const deployment = detectDeployment();
    lastDeployment = deployment;
    pushEvent('heartbeat', {
      service_type: 'application',
      language: host.language,
      framework: host.framework,
      runtime: host.runtime,
      os_info: host.os_info,
      hostname: host.hostname,
      node_env: host.env,
      dependencies: host.dependencies,
      deployment,
      // Same top-level pod/node/namespace/ECS fields captureException()
      // already attaches to every error event (via currentInfraSnapshot()) —
      // without these, N replicas of one service_name collapse into a single
      // undifferentiated heartbeat/health timeseries with no way to isolate
      // one pod's CPU/memory from the rest.
      ...deploymentIdentityFields(deployment),
      sonar,
      pipelines,
      containers,
      infra_resources: infraResources,
      migrations,
      ...metrics,
    });

    const toSend = buffer;
    buffer = [];
    const delivered = await sendEvents({ apiUrl, supabaseUrl, supabaseAnonKey, apiKey, events: toSend });
    if (!delivered) {
      // Requeue ahead of whatever accumulated during the failed send, then
      // enforce the cap by dropping the OLDEST events first — under a
      // prolonged outage, the most recent state is more actionable than the
      // start of it.
      const merged = toSend.concat(buffer);
      if (merged.length > maxBufferedEvents) {
        droppedEventCount += merged.length - maxBufferedEvents;
        buffer = merged.slice(merged.length - maxBufferedEvents);
      } else {
        buffer = merged;
      }
    } else if (droppedEventCount > 0) {
      console.error(`[eip-sdk] telemetry delivery recovered — ${droppedEventCount} event(s) were dropped while it was down.`);
      droppedEventCount = 0;
    }
  }

  const timer = setInterval(() => {
    flush().catch((err) => console.error('[eip-sdk] flush failed:', err.message));
  }, flushIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Send an initial heartbeat right away so the dashboard shows data immediately,
  // instead of waiting for the first flush interval to elapse.
  flush().catch((err) => console.error('[eip-sdk] initial flush failed:', err.message));

  // Kubernetes sends SIGTERM (then SIGKILL after the pod's grace period) on
  // every rolling deploy, scale-down, or eviction — with no handler for it,
  // whatever landed in `buffer` since the last flushIntervalMs tick died with
  // the process, silently, on every routine deploy. Bounded by
  // shutdownTimeoutMs so a stalled/unreachable backend can't hold up the
  // pod's own shutdown past its grace period.
  //
  // Only calls process.exit() itself when it's the sole listener for the
  // signal (checked at signal-time, not init time, since an app's own
  // graceful-shutdown handler is typically registered after eip.init() —
  // the very first line of the entry file per this SDK's own convention). An
  // app with its own SIGTERM handler keeps control of exiting; this flush
  // just races alongside it on a best-effort basis either way.
  let shutdownPromise = null;
  function flushBeforeExit() {
    if (shutdownPromise) return shutdownPromise;
    clearInterval(timer);
    shutdownPromise = Promise.race([
      flush().catch((err) => console.error('[eip-sdk] shutdown flush failed:', err.message)),
      new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
    ]);
    return shutdownPromise;
  }
  function installShutdownHandler(signal, exitCode) {
    process.on(signal, function eipShutdownHandler() {
      const isSoleHandler = process.listenerCount(signal) === 1;
      flushBeforeExit().then(() => {
        if (isSoleHandler) process.exit(exitCode);
      });
    });
  }
  installShutdownHandler('SIGTERM', 143);
  installShutdownHandler('SIGINT', 130);

  console.log(`[eip-sdk] Telemetry started (service: ${serviceName}, flush every ${flushIntervalMs}ms)`);
  console.log(`[eip-sdk] Discovery engine started (framework: ${host.framework}, dependencies: ${host.dependencies.length})`);
  console.log('[eip-sdk] Health monitoring started (CPU, memory, uptime, event loop lag, disk)');

  // Express request middleware — extracts an incoming W3C traceparent (if
  // present) so this request continues the caller's trace instead of always
  // starting a new one; a genuinely-new trace still gets parent_span_id:
  // null, same invariant as before (a dashboard root-span query depends on
  // it). Must be registered before any routes/other middleware that should
  // be covered.
  function middleware() {
    return function eipMiddleware(req, res, next) {
      const start = Date.now();
      const incoming = extractIncomingContext(req.headers);
      const { traceId, spanId, parentSpanId, baggage, tracestate } = incoming;
      // Adaptive sampling (Error Intelligence Phase 2, Tier 2.3): a brand-new
      // trace (no incoming traceparent) rolls its own sampling decision
      // against tracesSampleRate; a continued trace always respects the
      // upstream sampled flag instead of re-rolling, so a trace's sampling
      // decision stays consistent across every service it passes through
      // (head-based sampling, the standard approach).
      const sampled = parentSpanId === null ? Math.random() < tracesSampleRate : incoming.sampled;
      traceContext.run({ traceId, spanId, sampled, baggage, tracestate }, () => {
        res.on('finish', () => {
          const path = req.route ? req.baseUrl + req.route.path : req.path;
          const duration = Date.now() - start;
          // api_call telemetry is never sampled — dashboards need every
          // request for accurate volume/error-rate metrics. Only span/trace
          // volume is reduced by sampling, matching standard APM scope.
          pushEvent('api_call', {
            method: req.method,
            path,
            status_code: res.statusCode,
            duration_ms: duration,
          });
          if (sampled) {
            pushEvent('span', {
              trace_id: traceId,
              span_id: spanId,
              parent_span_id: parentSpanId,
              kind: 'server',
              name: `${req.method} ${path}`,
              target: null,
              status: res.statusCode >= 500 ? 'error' : 'ok',
              duration_ms: duration,
            });
          }
        });
        next();
      });
    };
  }

  // Express error-handling middleware — must be registered with app.use()
  // AFTER all routes, and must keep all four (err, req, res, next) params.
  function errorHandler() {
    return function eipErrorHandler(err, req, res, next) {
      captureException(err, {
        endpoint: req && req.originalUrl,
        headers: req && req.headers,
        requestBody: req && req.body,
      });
      next(err);
    };
  }

  process.on('uncaughtException', (err) => {
    captureException(err, { defaultName: 'UncaughtException' });
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    captureException(err, { defaultName: 'UnhandledRejection' });
  });

  // A Fastify plugin equivalent of middleware()/errorHandler() — sits on
  // top of the same pushEvent buffer/flush loop. Express apps (including
  // NestJS's default platform-express) should use middleware()/errorHandler()
  // instead; app.use(monitor.middleware()) on the underlying Express
  // instance works unchanged for a Nest app. For NestJS controller/service
  // errors specifically (which never reach Express-level error middleware —
  // Nest's own exception zone intercepts them first), use the dedicated
  // adapter in sdk/src/nestjs.js instead.
  function fastifyPlugin() {
    return function eipFastifyPlugin(fastify, _opts, done) {
      fastify.addHook('onRequest', (req, _reply, hookDone) => {
        req.eipStart = Date.now();
        const incoming = extractIncomingContext(req.headers);
        const { traceId, spanId, parentSpanId, baggage, tracestate } = incoming;
        // Same head-based sampling decision as middleware() above — see its
        // comment for why a continued trace respects the upstream flag
        // instead of re-rolling.
        const sampled = parentSpanId === null ? Math.random() < tracesSampleRate : incoming.sampled;
        req.eipTraceId = traceId;
        req.eipSpanId = spanId;
        req.eipParentSpanId = parentSpanId;
        req.eipSampled = sampled;
        traceContext.enterWith({ traceId, spanId, sampled, baggage, tracestate });
        hookDone();
      });
      fastify.addHook('onResponse', (req, reply, hookDone) => {
        const path = req.routeOptions && req.routeOptions.url ? req.routeOptions.url : req.url;
        const duration = Date.now() - (req.eipStart || Date.now());
        pushEvent('api_call', {
          method: req.method,
          path,
          status_code: reply.statusCode,
          duration_ms: duration,
        });
        if (req.eipSampled) {
          pushEvent('span', {
            trace_id: req.eipTraceId,
            span_id: req.eipSpanId,
            parent_span_id: req.eipParentSpanId || null,
            kind: 'server',
            name: `${req.method} ${path}`,
            target: null,
            status: reply.statusCode >= 500 ? 'error' : 'ok',
            duration_ms: duration,
          });
        }
        hookDone();
      });
      fastify.setErrorHandler((err, req, reply) => {
        captureException(err, {
          endpoint: req && req.url,
          headers: req && req.headers,
          requestBody: req && req.body,
        });
        reply.status(err.statusCode || 500).send({ error: err.message || 'Internal Server Error' });
      });
      done();
    };
  }

  // Queries at/above this take long enough to matter for user-facing latency
  // — flagged as a warn-level log so they surface in Logs Explorer/alerts,
  // on top of every query's duration already being recorded in db_queries
  // for the Infrastructure Dashboard's slow-query list.
  const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 200;

  // ---------------------------------------------------------------------
  // Shared reporters — both the manual wrap*() calls below and the
  // automatic instrumentation further down funnel through these, so a
  // hand-wrapped fake pool and a real pg.Pool patched automatically report
  // identically.
  // ---------------------------------------------------------------------
  function reportDbEvent(dbType, queryText, duration, status, errorMessage, slowQueryThresholdMs) {
    // Structured context (Error Intelligence Phase 2, Tier 2.2) — best-effort
    // table/operation extraction, computed on the raw (pre-redaction) text
    // since redaction only touches literal values, never the FROM/INTO/
    // UPDATE keywords or table identifiers this regex looks for.
    const { table_name, operation } = parseSqlContext(queryText);
    // Redact before truncating — a secret sitting past the 300-char cutoff
    // would otherwise survive as an unredacted fragment.
    pushEvent('db_query', {
      db_type: dbType,
      query_text: queryText ? redactor.redactText(String(queryText)).slice(0, 300) : null,
      duration_ms: duration,
      success: status === 'ok',
      error_message: errorMessage,
      table_name,
      operation,
    });
    if (duration >= slowQueryThresholdMs) {
      log('warn', `Slow ${dbType} query (${duration}ms): ${queryText ? String(queryText).slice(0, 200) : '<unknown>'}`, {
        db_type: dbType,
        duration_ms: duration,
      });
    }
    // Only emit a span if this query happened while handling a request — a
    // DB call with no active trace (e.g. a background job) has nowhere to
    // attach in a waterfall, so it's skipped rather than starting a
    // one-span trace of its own. Also skipped when the current trace wasn't
    // sampled (Tier 2.3) — db_query telemetry itself is never sampled
    // (still pushed above), only the span/waterfall entry is.
    const parent = traceContext.getStore();
    if (parent && parent.sampled !== false) {
      pushEvent('span', {
        trace_id: parent.traceId,
        span_id: generateSpanId(),
        parent_span_id: parent.spanId,
        kind: 'db',
        name: dbType,
        target: dbType,
        status,
        duration_ms: duration,
      });
    }
  }

  function reportCacheEvent(cacheType, methodName, key, duration, status, errorMessage) {
    pushEvent('db_query', {
      db_type: cacheType,
      query_text: `${methodName} ${key || ''}`.trim().slice(0, 300),
      duration_ms: duration,
      success: status === 'ok',
      error_message: errorMessage,
    });
    const parent = traceContext.getStore();
    if (parent && parent.sampled !== false) {
      pushEvent('span', {
        trace_id: parent.traceId,
        span_id: generateSpanId(),
        parent_span_id: parent.spanId,
        kind: 'cache',
        name: `${cacheType} ${methodName}`,
        target: cacheType,
        status,
        duration_ms: duration,
      });
    }
  }

  // `explicitSpanId` is passed by outgoing HTTP instrumentation (fetch/axios)
  // when it already generated a span id to inject into the traceparent
  // header — it MUST reuse that exact id here, not a fresh one, or the
  // parent-child link between this span and the downstream service's
  // continued trace orphans silently.
  function reportHttpEvent(targetName, method, duration, status, explicitSpanId) {
    const parent = traceContext.getStore();
    if (!parent || parent.sampled === false) return;
    pushEvent('span', {
      trace_id: parent.traceId,
      span_id: explicitSpanId || generateSpanId(),
      parent_span_id: parent.spanId,
      kind: 'external',
      name: `${method} ${targetName}`,
      target: targetName,
      status,
      duration_ms: duration,
    });
  }

  // Wraps a query(text, params)-shaped function (pg.Pool/Client, mysql2
  // Pool/Connection, or any compatible fake) so `this` still resolves
  // correctly whether `original` is pre-bound (manual wrapDatabase() below)
  // or a raw prototype method (automatic instrumentation further down).
  // Raw (non-promise) mysql2 Query objects define a `.then` method purely as
  // a guard — calling it throws synchronously with an instructive "use
  // mysql2/promise instead" error, rather than behaving like a real
  // thenable. A plain `typeof result.then === 'function'` check can't tell
  // that apart from a genuine Promise, so calling `.then()` on it here would
  // crash every callback-style caller (e.g. Sequelize's mysql dialect, which
  // uses the raw driver and its own `.on('result'/'error', ...)` handling).
  // Guard by invoking `.then` and falling back to the raw result if it
  // throws immediately instead of returning a real promise.
  function safeThen(result, onOk, onErr) {
    try {
      const chained = result.then(onOk, onErr);
      return chained === undefined ? result : chained;
    } catch {
      return result;
    }
  }

  function instrumentQueryMethod(original, dbType, slowQueryThresholdMs) {
    return function instrumentedQuery(...args) {
      const start = Date.now();
      const queryText = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        return safeThen(
          result,
          (value) => {
            reportDbEvent(dbType, queryText, Date.now() - start, 'ok', undefined, slowQueryThresholdMs);
            return value;
          },
          (err) => {
            reportDbEvent(dbType, queryText, Date.now() - start, 'error', err.message, slowQueryThresholdMs);
            throw err;
          }
        );
      }
      return result;
    };
  }

  function instrumentCacheMethod(original, methodName, cacheType) {
    return function instrumentedCacheCall(...args) {
      const start = Date.now();
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        return safeThen(
          result,
          (value) => {
            reportCacheEvent(cacheType, methodName, args[0], Date.now() - start, 'ok');
            return value;
          },
          (err) => {
            reportCacheEvent(cacheType, methodName, args[0], Date.now() - start, 'error', err.message);
            throw err;
          }
        );
      }
      return result;
    };
  }

  function safeHostFromUrl(url) {
    try {
      return new URL(typeof url === 'string' ? url : url.url).host;
    } catch {
      return 'external';
    }
  }

  // Merges W3C trace headers onto whatever shape fetch's `opts.headers` is —
  // a plain object, a Headers instance, an array of [key, value] tuples, or
  // undefined. Returns a plain object in all cases; fetch accepts a plain
  // object for `headers` regardless of what was passed in originally.
  function mergeFetchHeaders(existingHeaders, extraHeaders) {
    const merged = {};
    if (existingHeaders) {
      if (typeof existingHeaders.forEach === 'function' && typeof existingHeaders.entries === 'function') {
        // Headers instance
        existingHeaders.forEach((value, key) => {
          merged[key] = value;
        });
      } else if (Array.isArray(existingHeaders)) {
        existingHeaders.forEach(([key, value]) => {
          merged[key] = value;
        });
      } else {
        Object.assign(merged, existingHeaders);
      }
    }
    Object.assign(merged, extraHeaders);
    return merged;
  }

  // targetName is fixed for manual wrapHttpClient() calls, or left null for
  // automatic instrumentation, which derives it per-call from the URL. When
  // a trace is active, injects a W3C traceparent/baggage header onto the
  // outgoing request so the receiving service continues this trace — the
  // childSpanId generated here is reused as-is for the resulting span (see
  // reportHttpEvent's explicitSpanId doc comment).
  function instrumentFetchCall(original, targetName) {
    return async function instrumentedFetch(url, opts) {
      const start = Date.now();
      const method = (opts && opts.method) || 'GET';
      const resolvedTarget = targetName || safeHostFromUrl(url);
      const parent = traceContext.getStore();
      let finalOpts = opts;
      let childSpanId;
      if (parent) {
        childSpanId = generateSpanId();
        const traceHeaders = buildOutgoingHeaders({
          traceId: parent.traceId,
          childSpanId,
          sampled: parent.sampled,
          baggage: parent.baggage,
          tracestate: parent.tracestate,
        });
        finalOpts = { ...(opts || {}), headers: mergeFetchHeaders(opts && opts.headers, traceHeaders) };
      }
      try {
        const res = await original(url, finalOpts);
        reportHttpEvent(resolvedTarget, method, Date.now() - start, res.ok ? 'ok' : 'error', childSpanId);
        return res;
      } catch (err) {
        reportHttpEvent(resolvedTarget, method, Date.now() - start, 'error', childSpanId);
        throw err;
      }
    };
  }

  // Wraps a pg.Pool / mysql2-promise Pool's `query()` to time every call and
  // report it as a 'db_query' event — both expose an async query(text, params)
  // method with a compatible-enough signature for this to work unmodified.
  // Query text/params are sent as-is (truncated) with no redaction — fine for
  // a prototype, but don't point this at a pool handling sensitive literals
  // in unparameterized queries.
  //
  // Only needed for pools that autoInstrument can't see for itself — e.g. a
  // fake/mock pool that isn't actually obtained via require('pg'). A real
  // pg.Pool/mysql2 Pool is instrumented automatically (see below) with zero
  // calls to this.
  function wrapDatabase(pool, dbType, options) {
    if (!pool || typeof pool.query !== 'function') {
      throw new Error('[eip-sdk] wrapDatabase() requires a pool with a query() method');
    }
    const slowQueryThresholdMs = (options && options.slowQueryThresholdMs) || DEFAULT_SLOW_QUERY_THRESHOLD_MS;
    pool.query = instrumentQueryMethod(pool.query.bind(pool), dbType, slowQueryThresholdMs);
    return pool;
  }

  // Wraps common cache client methods (get/set/del/etc. — matches ioredis
  // and node-redis's method names) to time each call and report it as a
  // 'db_query' event (reusing the Database dashboard/table, since there's
  // no separate cache table) plus a 'cache' kind span for the Service
  // Dependency Graph — same reporting shape as wrapDatabase(), just aimed
  // at cache clients instead of SQL pools.
  //
  // Only needed for clients autoInstrument can't see for itself — a real
  // ioredis client is instrumented automatically (see below). Still useful
  // for node-redis (the `redis` package, not auto-instrumented) or a
  // fake/mock client.
  const CACHE_METHODS = ['get', 'set', 'setex', 'del', 'expire', 'incr', 'decr', 'hget', 'hset', 'exists'];

  function wrapCache(client, cacheType) {
    if (!client) {
      throw new Error('[eip-sdk] wrapCache() requires a client');
    }
    CACHE_METHODS.forEach((method) => {
      if (typeof client[method] !== 'function') return;
      client[method] = instrumentCacheMethod(client[method].bind(client), method, cacheType);
    });
    return client;
  }

  // Wraps a fetch-like function so calls to another service are timed and
  // reported as a child span of the current request's trace, with `target`
  // set to that service's name — this is what feeds the Service Dependency
  // Graph's cross-service edges. As of Error Intelligence Phase 1, this DOES
  // propagate trace context over the wire (W3C traceparent/baggage header
  // injection, see instrumentFetchCall()), so the callee's own spans/errors
  // are linked as children of this one — see traceContext's doc comment
  // above.
  //
  // The global fetch is already auto-instrumented (see below), deriving
  // `target` from the URL's host — call this yourself only if you want a
  // friendlier target name (e.g. 'product-service' instead of
  // 'localhost:4001') or need to wrap a non-global fetch implementation.
  function wrapHttpClient(fetchFn, targetName) {
    return instrumentFetchCall(fetchFn || fetch, targetName);
  }

  // Sprint 4 (docs/optimization_plan.md) — caps a single log message's byte
  // size the same way headers/request_body/query_params already are (see
  // capField/MAX_CAPTURED_FIELD_JSON_LENGTH above). Slicing a UTF-8 buffer at
  // a byte boundary can land mid-multi-byte-character; Buffer#toString
  // silently replaces the truncated tail with U+FFFD rather than throwing,
  // which is an acceptable cosmetic artifact on an already-truncated string.
  function truncateToByteLength(str, maxBytes) {
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= maxBytes) return str;
    return buf.slice(0, maxBytes).toString('utf8');
  }

  function log(level, message, metadata) {
    const ctx = traceContext.getStore();
    const fullMessage = String(message);
    const isTruncated = Buffer.byteLength(fullMessage, 'utf8') > maxLogSizeBytes;
    pushEvent('log', {
      level,
      message: isTruncated ? truncateToByteLength(fullMessage, maxLogSizeBytes) : fullMessage,
      is_truncated: isTruncated,
      metadata: metadata || null,
      trace_id: ctx ? ctx.traceId : null,
    });
  }

  const logger = {
    debug: (message, metadata) => log('debug', message, metadata),
    info: (message, metadata) => log('info', message, metadata),
    warn: (message, metadata) => log('warn', message, metadata),
    error: (message, metadata) => log('error', message, metadata),
  };

  // Error Intelligence Phase 2 (Tier 2.1) — opt-in user-impact tracking.
  // Call inside a request handler (after middleware()/fastifyPlugin() has
  // established the current request's trace context) to attach the current
  // end user to any error captured while handling it. A no-op outside an
  // active request context (e.g. called before middleware runs, or from a
  // background job with no active trace) rather than throwing — a
  // monitoring SDK must never be the reason a request fails.
  function setUser(user) {
    const ctx = traceContext.getStore();
    if (ctx) ctx.user = user || null;
  }

  // ---------------------------------------------------------------------
  // Automatic instrumentation — patches known libraries the moment the host
  // app require()s them, so telemetry works with zero wrap*() calls for the
  // common case (a real pg.Pool, a real ioredis client, a real axios
  // instance, the global fetch). This is what makes the SDK behave like
  // middleware that "just knows" about a service's dependencies, matching
  // what detect.js already reports to Architecture View from package.json,
  // instead of requiring a developer to hand each one to wrapDatabase()/
  // wrapCache()/wrapHttpClient() individually.
  //
  // Caveat inherent to any require-hook-based auto-instrumentation: a
  // library required *before* `eip.init()` runs was already returned from
  // require()'s module cache and won't pass through this hook. Call
  // `require('eip-sdk').init(...)` as the very first line of your entry
  // file (before requiring pg/ioredis/axios) for this to catch everything.
  // ---------------------------------------------------------------------
  function patchPrototypeMethod(proto, methodName, wrapFn) {
    if (!proto) return;
    const original = proto[methodName];
    if (typeof original !== 'function' || original.__eipInstrumented) return;
    const wrapped = wrapFn(original);
    wrapped.__eipInstrumented = true;
    proto[methodName] = wrapped;
  }

  function autoInstrumentModule(request, exported) {
    try {
      if (request === 'pg') {
        if (exported.Pool) patchPrototypeMethod(exported.Pool.prototype, 'query', (orig) => instrumentQueryMethod(orig, 'postgres', DEFAULT_SLOW_QUERY_THRESHOLD_MS));
        if (exported.Client) patchPrototypeMethod(exported.Client.prototype, 'query', (orig) => instrumentQueryMethod(orig, 'postgres', DEFAULT_SLOW_QUERY_THRESHOLD_MS));
      } else if (request === 'mysql2' || request === 'mysql2/promise') {
        ['Pool', 'Connection'].forEach((className) => {
          const cls = exported[className];
          if (!cls || !cls.prototype) return;
          patchPrototypeMethod(cls.prototype, 'query', (orig) => instrumentQueryMethod(orig, 'mysql', DEFAULT_SLOW_QUERY_THRESHOLD_MS));
          patchPrototypeMethod(cls.prototype, 'execute', (orig) => instrumentQueryMethod(orig, 'mysql', DEFAULT_SLOW_QUERY_THRESHOLD_MS));
        });
      } else if (request === 'ioredis') {
        const RedisClass = exported && (exported.default || exported);
        if (RedisClass && RedisClass.prototype) {
          CACHE_METHODS.forEach((method) => {
            patchPrototypeMethod(RedisClass.prototype, method, (orig) => instrumentCacheMethod(orig, method, 'redis'));
          });
        }
      } else if (request === 'axios') {
        // Injects the same W3C traceparent/baggage headers as
        // instrumentFetchCall() — axios re-normalizes whatever is assigned
        // to config.headers before dispatch (both plain-object headers in
        // axios v0.x and AxiosHeaders in v1.x), so a plain Object.assign
        // merge here is safe for either version.
        const wrapAxiosRequest = (original) =>
          function instrumentedAxiosRequest(config) {
            const start = Date.now();
            const url = (config && (config.url || config.baseURL)) || '';
            const method = ((config && config.method) || 'GET').toUpperCase();
            const target = safeHostFromUrl(url);
            const parent = traceContext.getStore();
            let finalConfig = config;
            let childSpanId;
            if (parent) {
              childSpanId = generateSpanId();
              const traceHeaders = buildOutgoingHeaders({
          traceId: parent.traceId,
          childSpanId,
          sampled: parent.sampled,
          baggage: parent.baggage,
          tracestate: parent.tracestate,
        });
              finalConfig = { ...config, headers: Object.assign({}, config && config.headers, traceHeaders) };
            }
            return original.call(this, finalConfig).then(
              (res) => {
                reportHttpEvent(target, method, Date.now() - start, 'ok', childSpanId);
                return res;
              },
              (err) => {
                reportHttpEvent(target, method, Date.now() - start, 'error', childSpanId);
                throw err;
              }
            );
          };

        // The default export's own `request` is already bound to
        // Axios.prototype.request at axios's own module-load time — before
        // this hook runs — so patching only the prototype wouldn't reach
        // calls made through `axios.get/post/...`. Patch that copy directly.
        const axiosInstance = exported && (exported.default || exported);
        if (axiosInstance && typeof axiosInstance.request === 'function' && !axiosInstance.request.__eipInstrumented) {
          const wrapped = wrapAxiosRequest(axiosInstance.request.bind(axiosInstance));
          wrapped.__eipInstrumented = true;
          axiosInstance.request = wrapped;
        }
        // Patching the shared prototype covers every axios.create() instance
        // the host app makes *after* this point (a very common pattern for a
        // configured client with a baseURL) — each one binds
        // Axios.prototype.request fresh at creation time, so it picks up
        // this patched version automatically. It does NOT cover an instance
        // created before eip.init() ran, same ordering caveat as everything
        // else in this file.
        const AxiosClass = exported && exported.Axios;
        if (AxiosClass && AxiosClass.prototype && typeof AxiosClass.prototype.request === 'function' && !AxiosClass.prototype.request.__eipInstrumented) {
          const wrapped = wrapAxiosRequest(AxiosClass.prototype.request);
          wrapped.__eipInstrumented = true;
          AxiosClass.prototype.request = wrapped;
        }
      } else if (request === 'mongodb') {
        // MongoDB's driver returns cursors (not promises) from find()/aggregate() —
        // the actual work happens on iteration/toArray(), not at call time — so
        // timing those here would report near-zero durations for the actual query
        // cost. Only the promise-returning CRUD methods are instrumented; find()/
        // aggregate() remain untraced (Mongoose sits on top of this driver with its
        // own separate model layer and isn't covered either — still a known gap).
        const MONGO_METHODS = ['findOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments'];
        const CollectionClass = exported && exported.Collection;
        if (CollectionClass && CollectionClass.prototype) {
          MONGO_METHODS.forEach((method) => {
            patchPrototypeMethod(CollectionClass.prototype, method, (orig) =>
              function instrumentedMongoCall(...args) {
                const start = Date.now();
                const collectionName = this && this.collectionName;
                const result = orig.apply(this, args);
                if (result && typeof result.then === 'function') {
                  return safeThen(
                    result,
                    (value) => {
                      reportDbEvent('mongodb', `${method} ${collectionName || ''}`.trim(), Date.now() - start, 'ok', undefined, DEFAULT_SLOW_QUERY_THRESHOLD_MS);
                      return value;
                    },
                    (err) => {
                      reportDbEvent('mongodb', `${method} ${collectionName || ''}`.trim(), Date.now() - start, 'error', err.message, DEFAULT_SLOW_QUERY_THRESHOLD_MS);
                      throw err;
                    }
                  );
                }
                return result;
              }
            );
          });
        }
      }
    } catch {
      // Auto-instrumentation must never break the host app's require() calls.
    }
  }

  function installRequireHook() {
    if (requireHookInstalled) return;
    requireHookInstalled = true;
    const originalLoad = Module._load;
    Module._load = function eipPatchedLoad(request, parent, isMain) {
      const exported = originalLoad.call(this, request, parent, isMain);
      if (AUTO_INSTRUMENT_MODULES.includes(request)) {
        autoInstrumentModule(request, exported);
      }
      return exported;
    };
  }

  function autoInstrumentGlobalFetch() {
    if (typeof globalThis.fetch !== 'function' || globalThis.fetch.__eipInstrumented) return;
    const wrapped = instrumentFetchCall(globalThis.fetch, null);
    wrapped.__eipInstrumented = true;
    globalThis.fetch = wrapped;
  }

  // Auto-instrumentation only ever affects modules required *after* this
  // point (see installRequireHook()'s doc comment) — if one of them is
  // already sitting in require.cache, silently doing nothing about it is
  // exactly the kind of gap that's invisible until someone notices a
  // dependency never shows up in the Architecture View. Best-effort: a
  // module this can't resolve (not installed, unusual resolution setup)
  // just gets skipped rather than throwing.
  function warnIfAlreadyLoaded() {
    const searchPaths = [process.cwd()];
    if (require.main) searchPaths.unshift(path.dirname(require.main.filename));
    AUTO_INSTRUMENT_MODULES.forEach((name) => {
      try {
        const resolved = require.resolve(name, { paths: searchPaths });
        if (Module._cache[resolved]) {
          console.warn(
            `[eip-sdk] '${name}' was required before eip.init() ran — automatic instrumentation for it will not activate. ` +
              `Call require('eip-sdk').init() as the very first line of your entry file, before requiring '${name}'.`
          );
        }
      } catch {
        // Not installed, or not resolvable from these paths — nothing to warn about.
      }
    });
  }

  if (autoInstrument) {
    warnIfAlreadyLoaded();
    installRequireHook();
    autoInstrumentGlobalFetch();
  }

  // Wraps console.log/info/warn/error/debug so telemetry works against
  // existing, uninstrumented code too — most real apps (and every
  // dependency they pull in) log via plain console calls, not a monitor
  // object, so relying only on logger/errorHandler above would miss almost
  // everything. Every console call still prints exactly as before; this
  // only adds a side-channel copy into the event buffer.
  function captureConsoleOutput() {
    Object.keys(CONSOLE_LEVELS).forEach((method) => {
      const original = console[method] ? console[method].bind(console) : () => {};
      console[method] = function eipPatchedConsole(...args) {
        original(...args);
        try {
          const message = formatConsoleArgs(args);
          // Skip the SDK's own startup/diagnostic lines so they don't loop
          // back into the buffer they're reporting on.
          if (message.startsWith('[eip-sdk]')) return;

          const level = CONSOLE_LEVELS[method];
          log(level, message);

          // Treat it as a real error event — not just a log line — if the
          // method itself is console.error, or if any argument is an Error
          // instance (covers sloppy `console.log('failed', err)` calls too).
          const errorArg = args.find((a) => a instanceof Error);
          if (errorArg || method === 'error') {
            // A plain console.error('failed') carries no Error object, so
            // there's no real stack to report — but a synthetic one, taken
            // right here at the call site, still pinpoints the exact
            // file/line/function that logged it, which is otherwise
            // impossible to recover after the fact.
            const stackForLocation = errorArg ? errorArg.stack : new Error('eip-sdk-synthetic').stack;
            captureException(
              { name: errorArg ? errorArg.name || 'Error' : 'ConsoleError', message: errorArg ? errorArg.message : message, stack: stackForLocation },
              {}
            );
          }
        } catch {
          // Telemetry capture must never break the app's own logging.
        }
      };
    });
  }

  if (captureConsole) captureConsoleOutput();

  return { middleware, errorHandler, fastifyPlugin, wrapDatabase, wrapCache, wrapHttpClient, flush, shutdown: flushBeforeExit, logger, captureException, setUser };
}

module.exports = { init };
