const os = require('os');
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const { readContainerLimits } = require('./cgroup');

// Best-effort disk usage for the current working directory's filesystem.
// fs.statfsSync is only available on Node 18.15+/19+ and not on all
// platforms (notably unreliable on Windows) — feature-detect and swallow
// any failure rather than let it take down metric collection.
function sampleDiskUsedPct() {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(process.cwd());
    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    if (!total) return null;
    return Math.round(((total - free) / total) * 1000) / 10;
  } catch {
    return null;
  }
}

// Returns { sample, peek }: `sample()` reports CPU% used since the
// *previous* call (approximated from process.cpuUsage() deltas), plus mean
// event-loop delay accumulated since the previous call — same behavior as
// before. `peek()` returns the last value `sample()` computed, with zero
// syscalls and zero state mutation.
//
// This split exists for error-time infra correlation (Error Intelligence
// Phase 1): calling `sample()` again from the error-capture hot path would
// be wrong on two counts, not just slower. First, sampleDiskUsedPct() does
// real synchronous disk I/O (fs.statfsSync) — under an error storm (exactly
// the moment infra correlation matters most, e.g. a bad deploy generating
// thousands of errors/sec) that would repeatedly block the event loop,
// worsening the incident it's meant to help diagnose. Second, `sample()`
// mutates state every call (lastCpuUsage/lastSampleTime, and critically
// eventLoopHistogram.reset()) — calling it again from the error path would
// corrupt the *next scheduled heartbeat's* CPU%/lag numbers by prematurely
// resetting the histogram mid-interval. `peek()` avoids both problems; infra
// numbers on an error can be up to one flush interval stale, which is an
// accepted tradeoff for zero added latency on the error path.
//
// CPU% and memory total are both normalized against the container's cgroup
// limits when present (falls back to host-wide os.cpus()/os.totalmem() when
// not containerized, or when a limit file reports "unlimited"). Without this,
// two bugs show up in exactly the deployments this SDK targets: a process
// using worker_threads to legitimately consume 2+ cores gets silently
// clamped to a flat 100% (dividing by 1 core instead of the real ceiling),
// and a pod capped at e.g. 512MB by Kubernetes reports a reassuring low
// percentage against the *host's* 64GB instead of its actual limit.
function createMetricsSampler() {
  let lastCpuUsage = process.cpuUsage();
  let lastSampleTime = Date.now();
  let lastMetrics = null;

  const { memoryLimitMb, cpuCores } = readContainerLimits();
  const effectiveCores = cpuCores || os.cpus().length || 1;
  const effectiveMemTotalMb = memoryLimitMb || os.totalmem() / (1024 * 1024);

  const eventLoopHistogram = monitorEventLoopDelay();
  eventLoopHistogram.enable();

  function sample() {
    const now = Date.now();
    const elapsedMs = now - lastSampleTime;
    const currentCpuUsage = process.cpuUsage();
    const userDiff = currentCpuUsage.user - lastCpuUsage.user;
    const sysDiff = currentCpuUsage.system - lastCpuUsage.system;
    const cpuPercent = elapsedMs > 0 ? ((userDiff + sysDiff) / 1000 / elapsedMs / effectiveCores) * 100 : 0;

    lastCpuUsage = currentCpuUsage;
    lastSampleTime = now;

    const memUsage = process.memoryUsage();

    const eventLoopLagMs = eventLoopHistogram.mean / 1e6;
    eventLoopHistogram.reset();

    lastMetrics = {
      cpu_percent: Math.min(100, Math.round(cpuPercent * 10) / 10),
      memory_used_mb: Math.round((memUsage.rss / (1024 * 1024)) * 10) / 10,
      memory_total_mb: Math.round(effectiveMemTotalMb * 10) / 10,
      uptime_seconds: Math.round(process.uptime()),
      event_loop_lag_ms: Number.isFinite(eventLoopLagMs) ? Math.round(eventLoopLagMs * 100) / 100 : null,
      disk_used_pct: sampleDiskUsedPct(),
    };
    return lastMetrics;
  }

  function peek() {
    return lastMetrics;
  }

  return { sample, peek };
}

module.exports = { createMetricsSampler };
