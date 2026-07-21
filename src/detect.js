const fs = require('fs');
const path = require('path');
const os = require('os');

const DEPENDENCY_TYPES = {
  pg: 'database',
  postgres: 'database',
  mysql: 'database',
  mysql2: 'database',
  mongodb: 'database',
  mongoose: 'database',
  redis: 'cache',
  ioredis: 'cache',
  stripe: 'external_api',
  twilio: 'external_api',
  '@sendgrid/mail': 'external_api',
  razorpay: 'external_api',
  axios: 'external_api',
};

// The npm package name isn't always what a human calls the underlying
// system — reported as this canonical label instead, so an Architecture
// View node reads "redis"/"postgres" regardless of which client library the
// app happens to use, matching the `target`/`db_type` string a developer
// typically passes to wrapDatabase()/wrapCache() (e.g. `wrapCache(client,
// 'redis')`) for the same dependency.
const DEPENDENCY_DISPLAY_NAMES = {
  pg: 'postgres',
  mysql2: 'mysql',
  ioredis: 'redis',
};

function findHostPackageJson(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// TypeScript vs plain JavaScript, inferred the same way most tooling does:
// a `typescript` dependency, a tsconfig.json next to package.json, or the
// entry point itself being a .ts/.tsx file.
function detectLanguage(pkg, deps, pkgDir) {
  if (deps.typescript || deps['ts-node'] || deps.tsx) return 'TypeScript';
  if (pkgDir && fs.existsSync(path.join(pkgDir, 'tsconfig.json'))) return 'TypeScript';
  const entry = pkg.main || '';
  if (/\.tsx?$/.test(entry)) return 'TypeScript';
  return 'JavaScript';
}

function detectHost() {
  const pkgPath = findHostPackageJson(process.cwd());
  let pkg = {};
  try {
    if (pkgPath) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    pkg = {};
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  let framework = 'unknown';
  if (deps.express) framework = 'express';
  else if (deps['@nestjs/core']) framework = 'nestjs';
  else if (deps.fastify) framework = 'fastify';

  const dependencies = Object.keys(DEPENDENCY_TYPES)
    .filter((name) => deps[name])
    .map((name) => ({ name: DEPENDENCY_DISPLAY_NAMES[name] || name, type: DEPENDENCY_TYPES[name] }));

  return {
    language: detectLanguage(pkg, deps, pkgPath ? path.dirname(pkgPath) : null),
    framework,
    runtime: `Node.js ${process.version}`,
    os_info: `${os.platform()} ${os.release()}`,
    hostname: os.hostname(),
    env: process.env.NODE_ENV || 'development',
    dependencies,
  };
}

module.exports = { detectHost };
