# archonix-sdk

Drop-in telemetry SDK for Express, Fastify, and NestJS apps. Reports architecture (framework, runtime, detected dependencies), API metrics, database query metrics, errors (with release/deployment/cross-service-trace/infrastructure context and PII redaction — see "Error Intelligence" below), and infrastructure stats (CPU/memory/uptime/event-loop-lag/disk) to your EIP project so they show up live in the mobile app.

## Install

```
npm install archonix-sdk
```

## Quick start: `npx eip init`

Run this from your backend project's root directory:

```
npx eip init
```

(or add `"eip": "eip"` to your own `package.json` scripts once `archonix-sdk` is a dependency, then `npm run eip -- init`)

It will:
1. Ask for your Supabase URL/anon key (or read `EIP_SUPABASE_URL` / `EIP_SUPABASE_ANON_KEY` env vars if set) and your account email/password.
2. List your organizations and let you pick one.
3. Create a new project with a fresh API key.
4. Send a test heartbeat to confirm connectivity.
5. Write `eip.config.json` to the current directory and print the exact `require`/`init()` snippet to paste into your app.

## Manual usage (Express)

```js
// Require archonix-sdk (and call init()) before requiring pg/ioredis/axios/etc —
// see "Automatic instrumentation" below for why the order matters.
const eip = require('archonix-sdk');

const monitor = eip.init({
  apiKey: 'eip_test_...',          // from Create Project > API Access in the app, or eip.config.json

  // Telemetry destination — pick ONE of the two below (see
  // docs/NODEJS_BACKEND_MIGRATION_PLAN.md, Decision Point 1):
  apiUrl: 'https://your-eip-backend.example.com',  // preferred: the NestJS ingestion endpoint
  // supabaseUrl: 'https://xxxx.supabase.co',       // legacy fallback: posts straight to Supabase's ingest_events RPC
  // supabaseAnonKey: 'eyJ...',                     // only needed with supabaseUrl, not with apiUrl

  serviceName: 'my-api',           // optional, defaults to "default"

  // Error Intelligence Phase 1 (P0) — all optional, see "Error Intelligence"
  // below for the full picture:
  // release: { version: '1.4.2', commitSha: process.env.GITHUB_SHA, branch: process.env.GITHUB_REF_NAME },
  // environment: 'production',
});

const express = require('express');
const app = express();

app.use(monitor.middleware());     // register before your routes

app.get('/users', (req, res) => res.json([]));

app.use(monitor.errorHandler());   // register after your routes

app.listen(3000);
```

## Automatic instrumentation

By default (`autoInstrument: true`), the SDK patches known libraries the moment your app `require()`s them — no `wrapDatabase()`/`wrapCache()`/`wrapHttpClient()` calls needed for the common case:

- `pg` (`Pool`/`Client`) and `mysql2`/`mysql2/promise` (`Pool`/`Connection`) — every `query()`/`execute()` call is timed and reported as `db_type: 'postgres'`/`'mysql'`.
- `ioredis` — every `get`/`set`/`setex`/`del`/`expire`/`incr`/`decr`/`hget`/`hset`/`exists` call is reported as `db_type: 'redis'` plus a `cache` kind span.
- `axios` and the global `fetch` — every outbound call is reported as an `external` kind span, with `target` derived from the request URL's host (e.g. `localhost:4001`).

This works by hooking Node's module loader, so it only sees a library `require()`'d *after* `eip.init()` runs — put `require('archonix-sdk')` and `init()` as the first lines of your entry file, before `require('pg')`/`require('ioredis')`/etc., or that library's first `require()` (wherever it happens in your dependency tree) won't be caught.

Manual `wrapDatabase()`/`wrapCache()`/`wrapHttpClient()` calls still exist for what auto-instrumentation can't see: a mock/fake client (e.g. in tests), `node-redis` (the `redis` package — no simple class prototype to patch), or when you want a friendlier `target` name than a raw host (`wrapHttpClient(fetch, 'product-service')` instead of `localhost:4001`).

## NestJS

NestJS's default HTTP adapter (`platform-express`) is Express under the hood, so `monitor.middleware()` works unchanged for request timing/trace-context propagation — register it on the underlying Express instance:

```js
const app = await NestFactory.create(AppModule);
app.use(monitor.middleware());
```

**`monitor.errorHandler()` alone is not enough for a NestJS app.** Nest's own exception zone intercepts errors thrown from controllers/services *before* they ever reach Express-level error middleware, so `app.use(monitor.errorHandler())` only ever sees errors from raw, non-Nest-routed Express middleware — never anything thrown from your actual routed code. Use the dedicated adapter instead, which reuses the exact same `middleware()`/`captureException()` core (not a parallel reimplementation):

```js
const { createEipModule, createEipExceptionFilter } = require('archonix-sdk/nestjs');

// registers monitor.middleware() via Nest's own NestModule.configure() hook
@Module({ imports: [createEipModule(monitor)] })
export class AppModule {}

// captures the exception, then delegates to Nest's normal response
// formatting unchanged — this filter only observes
app.useGlobalFilters(new (createEipExceptionFilter(monitor))());
```

`@nestjs/common`/`@nestjs/core` are optional peer dependencies of `archonix-sdk` — only required if you actually `require('archonix-sdk/nestjs')`; Express/Fastify-only apps never need to install Nest.

## Fastify

Use the plugin form instead of `middleware()`/`errorHandler()`:

```js
const fastify = require('fastify')();
fastify.register(monitor.fastifyPlugin());
```

## Database monitoring (manual fallback)

A real `pg.Pool`/`Client` or `mysql2`/`mysql2/promise` `Pool`/`Connection` is instrumented automatically (see above). Use `wrapDatabase()` yourself only for a mock/fake pool, or another driver with a compatible `query(text, params)` method:

```js
const pool = monitor.wrapDatabase(myFakeOrCustomPool, 'postgres');
// use `pool` exactly as before — query() is transparently timed and reported
```

Query text is sent truncated to ~300 characters with no redaction — don't wrap a pool that runs unparameterized queries containing sensitive literals.

## Cache monitoring (manual fallback)

A real `ioredis` client is instrumented automatically (see above). Use `wrapCache()` yourself for `node-redis` (the `redis` package — no simple class prototype to patch) or a mock/fake client:

```js
const redis = monitor.wrapCache(myRedisClientOrFake, 'redis');
// use `redis` exactly as before — get/set/del/etc. are transparently timed and reported
```

Only wraps methods that exist on the client (`get`, `set`, `setex`, `del`, `expire`, `incr`, `decr`, `hget`, `hset`, `exists`).

## Service dependency edges (manual fallback)

The global `fetch` and `axios` are instrumented automatically (see above), deriving `target` from the request URL's host. Use `wrapHttpClient()` yourself when you want a friendlier name instead (e.g. `'product-service'` instead of `'localhost:4001'`), or need to wrap a non-global fetch implementation:

```js
const callProductService = monitor.wrapHttpClient(fetch, 'product-service');
const res = await callProductService('http://localhost:4001/products/1');
```

As of Error Intelligence Phase 1, this **does** propagate trace context over the wire: a W3C `traceparent`/`baggage` header is injected on the outgoing call (also true for auto-instrumented `axios`/global `fetch`), so the receiving service — if it's also running eip-sdk — continues the same trace instead of starting a new one. A multi-hop chain like `Gateway → Order Service → Payment Service → Inventory Service` shows up as one trace end-to-end, and an error anywhere in that chain carries the same `trace_id` as the request that triggered it.

## Error Intelligence (Phase 1)

Every captured error (Express/Fastify/NestJS handler, `uncaughtException`, `unhandledRejection`, or a `console.error` with an `Error` argument) now carries release, deployment, cross-service trace, and infrastructure context automatically, plus goes through recursive PII redaction before it leaves the process.

**Release tracking** — set once at `init()`, attached to every event (not just errors):

```js
eip.init({
  // ...
  release: { version: '1.4.2', commitSha: process.env.GITHUB_SHA, branch: process.env.GITHUB_REF_NAME },
  environment: 'production',
});
```

If you don't set `release` explicitly, the SDK falls back to `EIP_RELEASE_VERSION`/`EIP_RELEASE_COMMIT_SHA`/`EIP_RELEASE_BRANCH` env vars, then to common CI vars (`GITHUB_SHA`/`GITHUB_REF_NAME`, `CI_COMMIT_SHA`/`CI_COMMIT_REF_NAME`, `npm_package_version`). `environment` falls back to `EIP_ENVIRONMENT`, then `NODE_ENV`. Everything here is optional — an app that sets none of it keeps ingesting exactly as before.

**Deployment correlation** — when an error's reported `commitSha` matches a `deployments` row for the same project/service (populated by the GitHub Deployments API poller, see Project Settings → Integrations), the dashboard shows "this error started N minutes after deployment" without any extra SDK config.

**Database migration correlation** — zero-config: `init()` scans common migration directories once at startup (`migrations/`, `db/migrate/` (Rails), `alembic/versions/` (Python), `db/migration/` (Flyway), `prisma/migrations/`) and reports the most recent 30 on every heartbeat. The dashboard can then show "nearest migration applied before this error." Important limitation: a migration file's mtime is a proxy for "when it was added to the repo," not proof it actually ran against a database in this environment — there's no query to a real migrations-tracking table (`schema_migrations`, `alembic_version`, etc.).

**Cross-service trace propagation** — real [W3C Trace Context](https://www.w3.org/TR/trace-context/) (`traceparent`/`tracestate`/`baggage` headers), not an internal-only id. `tracestate` entries from upstream vendors are forwarded unmodified; this SDK adds its own `eip=<span-id>` entry at the front of the list on each hop (per spec, a system that mutates tracestate moves its own entry to the front rather than appending). See "Service dependency edges" above for outgoing propagation and the NestJS section above for the exception-filter integration point. Every error carries the `trace_id`/`span_id` of the request that triggered it, so you can jump from an error straight to its full cross-service trace.

**Infrastructure correlation** — every error snapshots the *last sampled* CPU%/memory/event-loop-lag (never a fresh synchronous read on the error path — see `sdk/src/collector.js`'s `sample`/`peek` split), plus hostname/container id/pod name/node name/namespace. Kubernetes pod/node identity comes from the standard [downward API](https://kubernetes.io/docs/tasks/inject-data-application/downward-api-volume-expose-pod-information/) env vars — add this to your pod spec if you want `pod_name`/`node_name` populated (the SDK cannot read these from inside the container without it; `HOSTNAME` alone, set automatically by Kubernetes with zero pod-spec config, already covers the common case):

```yaml
env:
  - name: POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: NODE_NAME
    valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
  - name: POD_NAMESPACE
    valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
```

**PII redaction** — recursive (nested objects/arrays, circular-safe, depth-capped), not just the previous flat/shallow pass. Request headers and query params are captured and redacted by default; request bodies are opt-in (`captureRequestBody: true`) since they're the highest-PII-surface and unbounded in size:

```js
eip.init({
  // ...
  captureHeaders: true,        // default true
  captureQueryParams: true,    // default true
  captureRequestBody: false,   // default false — opt in explicitly
  redactionDenylist: ['x_internal_secret', /^x-.*-token$/i],   // always redacted, on top of the built-in defaults
  redactionAllowlist: ['access_token_count'],                   // rescues a field the *default* denylist over-matches
});
```

Precedence on conflict: your `redactionDenylist` always wins → your `redactionAllowlist` can rescue a default-denylist false positive → the built-in default denylist (passwords, tokens, secrets, API keys, cookies, credit card numbers, etc.) → otherwise not redacted by key name. Every string value still runs through a pattern scan for JWTs/Bearer tokens/`key=value` secrets regardless of its key name, catching a secret embedded in an innocuously-named field.

## Deployment tracking (Docker / ECS / Kubernetes)

`init()` automatically detects what platform the process is running on (`/.dockerenv`/cgroup for Docker, `ECS_CONTAINER_METADATA_URI_V4` for ECS, `KUBERNETES_SERVICE_HOST` for Kubernetes, `'bare-metal'` otherwise) and includes it in every heartbeat — no config needed. This shows up as a platform badge + container/cluster/pod details on the service in Architecture View.

This only reports what the process can see about *itself*. It can't see a sibling container that isn't running an eip-sdk process, and it can't report its own crash or OOM-kill — the process is gone by the time that happens. For that, run the separate watcher CLI alongside your services, which polls the Docker/ECS/Kubernetes API directly from the outside:

```bash
# Docker — polls `docker stats` + watches `docker events` for start/die/stop/restart/oom
npx eip-watch --docker --api-key eip_test_... --supabase-url https://xxxx.supabase.co --supabase-anon-key eyJ...

# AWS ECS — polls DescribeServices (scale up/down) + DescribeTasks (crashes), needs @aws-sdk/client-ecs
npx eip-watch --ecs --cluster my-cluster --service my-service

# Kubernetes — polls pod restart counts (crashes/OOM kills), needs @kubernetes/client-node
npx eip-watch --kubernetes --namespace default
```

(or set `EIP_API_KEY`/`EIP_SUPABASE_URL`/`EIP_SUPABASE_ANON_KEY` env vars instead of the `--api-key`/`--supabase-url`/`--supabase-anon-key` flags). It reports container lifecycle events (`start`/`stop`/`die`/`restart`/`oom_kill`/`scale_up`/`scale_down`, visible in Architecture View's Container Events panel) plus per-container CPU/memory stats, reusing the same `ingest_events` pipeline the in-process SDK uses — a watcher is really just an eip-sdk client reporting on behalf of containers that aren't running one of their own.

The ECS and Kubernetes watchers are implemented against the real `@aws-sdk/client-ecs`/`@kubernetes/client-node` SDKs but weren't tested against a live cluster during development (no AWS/Kubernetes access in that environment) — verify against a real cluster before relying on them in production. The Docker watcher was tested end-to-end against real containers.

## Security & code quality (SonarQube / SARIF / npm audit)

There are two ways to get scan results into the Security & Quality dashboard — pick whichever fits the tool:

**Automatic (recommended when it applies)**: add a SonarQube server or a GitHub Actions artifact under a project's **Settings → Integrations** in the app — no CI/CLI step needed afterward. A scheduled Supabase Edge Function (`supabase/functions/poll-sonarqube`, `poll-github-artifacts`) polls it automatically (every ~30 minutes by default, see `supabase/cron-setup.sql`) and keeps findings in sync: new findings appear as `open`, and any previously-open finding that stops showing up on a poll is automatically marked `fixed` — nobody has to manually close it. This only works for SonarQube (a persistent server with its own API) and for tools whose SARIF/npm-audit JSON output your CI uploads as a named GitHub Actions artifact (`actions/upload-artifact`) — the poller downloads and parses the latest one automatically.

Setting up the SonarQube half of this needs even less typing than it looks: the in-process SDK already auto-detects `sonar.projectKey`/`sonar.host.url` from a `sonar-project.properties`, `pom.xml`, or `build.gradle`/`build.gradle.kts` file in the service's own repo (`sdk/src/sonar-detect.js`) and reports it on every heartbeat. Once a service with one of those files has sent a heartbeat, its detected project key shows up as a one-click suggestion chip in the Integrations form — the only thing you have to type by hand is the SonarQube token itself (never auto-detected, since tokens don't belong in version control).

**Manual CI push**: run `eip-scan-report` as a CI step right after your scan finishes — it's a one-shot push, not continuous telemetry. Use this for tools/setups the automatic path doesn't cover (non-GitHub CI, ad hoc/local runs, or a SARIF/npm-audit file you don't want uploaded as a persistent artifact):

```bash
# SonarQube — pulls quality gate status, bugs/vulnerabilities/code smells/coverage/ratings, and open issues from the Web API.
# --sonar-url and --project-key are only needed if the repo has no sonar-project.properties/pom.xml/build.gradle to auto-detect them from.
npx eip-scan-report --sonarqube --sonar-token squ_... \
  --api-key eip_test_... --supabase-url https://xxxx.supabase.co --supabase-anon-key eyJ...

# SARIF — any tool that can emit it: Trivy, Snyk, CodeQL, Semgrep, ESLint, Bandit, ...
trivy fs --format sarif -o results.sarif .
npx eip-scan-report --sarif results.sarif --service-name my-app

# npm audit
npm audit --json > audit.json
npx eip-scan-report --npm-audit audit.json --service-name my-app
```

(or set `EIP_API_KEY`/`EIP_SUPABASE_URL`/`EIP_SUPABASE_ANON_KEY` env vars). Each run reports a scan summary (quality gate pass/fail, bug/vulnerability/code-smell counts, coverage, security/reliability/maintainability ratings where the tool provides them) plus one finding per issue — all visible in the Security & Quality dashboard. Severities from each tool's own scale (SonarQube's BLOCKER..INFO, SARIF's error/warning/note or a numeric `security-severity` score, npm audit's critical..info) are normalized to one critical/high/medium/low/info scale so findings from different tools sort and filter together. SARIF and npm audit have no native pass/fail concept, so their quality gate is synthesized: failed if any high/critical finding exists.

The SonarQube integration (both the CLI and the automatic poller) is implemented against the real Web API but wasn't tested against a live SonarQube server during development (none was available in that environment) — verify before relying on it in production. The SARIF and npm audit parsers were tested against real/spec-accurate sample reports; the GitHub Actions artifact poller's download/unzip logic was not tested against a real repo/workflow run — verify before relying on it in production.

That's it — no CLI step required if you generate the API key from the app instead. Within ~10 seconds you'll see the service appear in Architecture View, and API/Error/Infrastructure/Database dashboards start filling in as traffic flows through your app.

## What it does

- **Architecture discovery**: reads your app's `package.json` once to detect the framework and known dependencies (databases, caches, external APIs), reported as nodes in Architecture View. Projects with exactly one discovered service are labeled "monolith"; more than one is labeled "microservices".
- **Deployment tracking**: automatic platform detection (Docker/ECS/Kubernetes/bare metal) from the in-process SDK; live container lifecycle events and per-container stats from the separate `eip-watch` CLI.
- **Security & code quality**: automatic scheduled polling (SonarQube server, or a SARIF/npm-audit GitHub Actions artifact) once configured under Project Settings → Integrations, or a one-shot CI-time push via the `eip-scan-report` CLI — either way, normalized to one severity scale in the Security & Quality dashboard.
- **API monitoring**: wraps each request/response to record method, route, status code, and duration, including p50/p95/p99 latency and 4xx/5xx breakdowns computed on the mobile side.
- **Database monitoring**: automatic for `pg`/`mysql2`, records query count, duration, and failures per pool.
- **Cache monitoring**: automatic for `ioredis`, records cache call count, duration, and failures per client, alongside database queries in the same dashboard.
- **Error monitoring**: captures Express/Fastify/NestJS errors plus any `uncaughtException`/`unhandledRejection` in the process, each carrying release/deployment/cross-service-trace/infrastructure context and going through recursive PII redaction (see "Error Intelligence" above). Errors are grouped into persistent, fingerprinted issues (`error_groups`) with a New/Active/Resolved/Regressed lifecycle, ranked by occurrence count.
- **Infrastructure monitoring**: every flush interval (default 10s), reports CPU%, memory, process uptime, event-loop lag, and best-effort disk usage (not available on all platforms, e.g. Windows).
- **Alerting**: the ingestion RPC itself opens/closes `alert_history` rows as thresholds are crossed (high CPU/memory/error-rate/latency) — no separate notification channel, alerts are visible in the mobile app's Alerts tab.

Everything is buffered in memory and sent in one batched, fire-and-forget request per flush interval — it never blocks your app's request/response cycle.
