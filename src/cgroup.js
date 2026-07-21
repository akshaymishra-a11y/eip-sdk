const fs = require('fs');
const os = require('os');

// Best-effort cgroup limit reader. Node's os.totalmem()/os.cpus().length report
// the *host's* resources — inside a Docker/Kubernetes container capped well
// below the host (e.g. a 512MB pod on a 64GB node), that makes CPU/memory %
// look artificially healthy right up until the container OOMs or throttles.
// This reads the container's actual limit from cgroup v2 (unified hierarchy)
// or v1 (legacy, still what most CI/older Docker setups use), and returns
// null when unlimited/not containerized so callers fall back to host stats.

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function isCgroupV2() {
  return fs.existsSync('/sys/fs/cgroup/cgroup.controllers');
}

// A limit file reporting a value at/above the host's own total is not really
// constraining anything (common default for an unbounded container) — treat
// it the same as "unlimited" rather than a real, tighter ceiling.
function memoryLimitBytes() {
  if (isCgroupV2()) {
    const raw = readFile('/sys/fs/cgroup/memory.max');
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value < os.totalmem() ? value : null;
  }
  const raw = readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value < os.totalmem() ? value : null;
}

// Returns the number of cores this process is actually allowed to use —
// e.g. a `--cpus=2` container reports 2 even on a 32-core host. Falls back to
// the host's full core count when there's no quota (matches how the process
// could legitimately use every core it can see).
function cpuLimitCores() {
  if (isCgroupV2()) {
    const raw = readFile('/sys/fs/cgroup/cpu.max');
    if (!raw) return null;
    const [quota, period] = raw.split(/\s+/);
    if (quota === 'max') return null;
    const q = Number(quota);
    const p = Number(period);
    return Number.isFinite(q) && Number.isFinite(p) && p > 0 ? q / p : null;
  }
  const quotaRaw = readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const periodRaw = readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (!quotaRaw || !periodRaw) return null;
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

// Both wrapped individually — a partial/odd cgroup mount (seen on some CI
// runners) should degrade to host stats for that one metric, not throw and
// take down metric collection entirely.
function readContainerLimits() {
  let memoryLimitMb = null;
  let cpuCores = null;
  try {
    const bytes = memoryLimitBytes();
    if (bytes) memoryLimitMb = bytes / (1024 * 1024);
  } catch {
    // ignore — no cgroup mount (non-Linux host, or not containerized)
  }
  try {
    cpuCores = cpuLimitCores();
  } catch {
    // ignore
  }
  return { memoryLimitMb, cpuCores };
}

module.exports = { readContainerLimits };
