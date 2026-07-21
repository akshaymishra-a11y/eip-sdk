#!/usr/bin/env node

// Standalone watcher: unlike the in-process eip-sdk, this runs outside any
// monitored app and polls the Docker/ECS/Kubernetes API directly, so it can
// see containers no in-process SDK is running inside, and can report a
// container's own death (start/die/stop/restart/oom_kill/scale_up/
// scale_down) — something a crashed process obviously can't do for itself.
const { createReporter } = require('../src/watchers/report');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--docker' || arg === '--ecs' || arg === '--kubernetes' || arg === '--k8s') {
      args.platform = arg === '--k8s' ? 'kubernetes' : arg.slice(2);
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function printUsage() {
  console.log(`
Usage: eip-watch --docker|--ecs|--kubernetes [options]

Common (or set EIP_API_KEY / EIP_SUPABASE_URL / EIP_SUPABASE_ANON_KEY):
  --api-key <key>              EIP project API key
  --supabase-url <url>         Supabase project URL
  --supabase-anon-key <key>    Supabase anon key

--docker:
  --socket <path>              Docker socket path (default: platform default)
  --label <key=value>          Only watch containers with this label

--ecs:
  --cluster <name>              ECS cluster name (required)
  --service <name>              ECS service name (required)
  --region <region>             AWS region (default: SDK's default chain)

--kubernetes:
  --namespace <name>            Namespace to watch (default: "default")
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.platform) {
    printUsage();
    process.exit(1);
  }

  const apiKey = args.apiKey || process.env.EIP_API_KEY;
  const supabaseUrl = args.supabaseUrl || process.env.EIP_SUPABASE_URL;
  const supabaseAnonKey = args.supabaseAnonKey || process.env.EIP_SUPABASE_ANON_KEY;

  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    console.error(
      '[eip-watch] --api-key/--supabase-url/--supabase-anon-key (or EIP_API_KEY/EIP_SUPABASE_URL/EIP_SUPABASE_ANON_KEY env vars) are required.'
    );
    process.exit(1);
  }

  const reporter = createReporter({ apiKey, supabaseUrl, supabaseAnonKey });

  let stop;
  if (args.platform === 'docker') {
    const { watchDocker } = require('../src/watchers/docker');
    stop = await watchDocker({ reporter, socketPath: args.socket, labelFilter: args.label });
  } else if (args.platform === 'ecs') {
    const { watchEcs } = require('../src/watchers/ecs');
    stop = await watchEcs({ reporter, cluster: args.cluster, service: args.service, region: args.region });
  } else if (args.platform === 'kubernetes') {
    const { watchKubernetes } = require('../src/watchers/kubernetes');
    stop = await watchKubernetes({ reporter, namespace: args.namespace });
  } else {
    printUsage();
    process.exit(1);
  }

  process.on('SIGINT', () => {
    console.log('\n[eip-watch] Stopping...');
    if (stop) stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[eip-watch] fatal error:', err.message);
  process.exit(1);
});
