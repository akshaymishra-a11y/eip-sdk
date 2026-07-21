#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { detectHost } = require('../src/detect');

const ENTER_CODES = [10, 13]; // \n, \r
const BACKSPACE_CODES = [8, 127];
const CTRL_C_CODE = 3;

function prompt(rl, question, { mask = false, defaultValue } = {}) {
  return new Promise((resolve) => {
    if (!mask) {
      rl.question(question, (answer) => resolve(answer.trim() || defaultValue || ''));
      return;
    }
    // Minimal masked-input prompt using raw stdin (works in most terminals).
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      const code = char.charCodeAt(0);
      if (ENTER_CODES.includes(code)) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (code === CTRL_C_CODE) {
        process.exit(1);
      }
      if (BACKSPACE_CODES.includes(code)) {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    stdin.on('data', onData);
  });
}

function generateApiKey(environment) {
  const prefix = environment === 'production' ? 'eip_live' : 'eip_test';
  const random = crypto.randomUUID().replace(/-/g, '');
  return `${prefix}_${random}`;
}

async function main() {
  console.log('\neip-sdk init - connect this project to Engineering Intelligence Platform\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const supabaseUrl = process.env.EIP_SUPABASE_URL || (await prompt(rl, 'Supabase URL: '));
  const supabaseAnonKey = process.env.EIP_SUPABASE_ANON_KEY || (await prompt(rl, 'Supabase anon key: '));

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('\n[eip] Supabase URL and anon key are required (set EIP_SUPABASE_URL / EIP_SUPABASE_ANON_KEY to skip the prompts).');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const email = await prompt(rl, 'Account email: ');
  const password = await prompt(rl, 'Account password: ', { mask: true });

  console.log('\n[eip] Signing in...');
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) {
    console.error(`[eip] Sign-in failed: ${signInError.message}`);
    process.exit(1);
  }

  const { data: orgs, error: orgError } = await supabase.from('organizations').select('*').order('created_at', { ascending: true });
  if (orgError) {
    console.error(`[eip] Could not list organizations: ${orgError.message}`);
    process.exit(1);
  }
  if (!orgs || orgs.length === 0) {
    console.error('[eip] No organizations found for this account - create one in the mobile/web app first.');
    process.exit(1);
  }

  let organizationId = orgs[0].id;
  if (orgs.length > 1) {
    console.log('\nOrganizations:');
    orgs.forEach((org, i) => console.log(`  ${i + 1}. ${org.name}`));
    const choice = await prompt(rl, `Pick an organization [1-${orgs.length}] (default 1): `, { defaultValue: '1' });
    const index = Math.max(1, Math.min(orgs.length, parseInt(choice, 10) || 1)) - 1;
    organizationId = orgs[index].id;
  }

  const projectName = await prompt(rl, '\nProject name: ');
  const environment =
    (await prompt(rl, 'Environment (development/staging/production) [development]: ', { defaultValue: 'development' })) || 'development';

  const apiKey = generateApiKey(environment);

  console.log('\n[eip] Creating project...');
  const { data: userData } = await supabase.auth.getUser();
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .insert({
      organization_id: organizationId,
      name: projectName,
      environment,
      api_key: apiKey,
      created_by: userData.user.id,
    })
    .select()
    .single();
  if (projectError) {
    console.error(`[eip] Could not create project: ${projectError.message}`);
    process.exit(1);
  }

  console.log('[eip] Validating connectivity...');
  const host = detectHost();
  const { error: ingestError } = await supabase.rpc('ingest_events', {
    p_api_key: apiKey,
    p_events: [
      {
        kind: 'heartbeat',
        payload: {
          service_name: 'default',
          service_type: 'application',
          framework: host.framework,
          runtime: host.runtime,
          os_info: host.os_info,
          hostname: host.hostname,
          node_env: host.env,
          dependencies: host.dependencies,
          cpu_percent: 0,
          memory_used_mb: 0,
          memory_total_mb: 0,
          uptime_seconds: 0,
        },
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  if (ingestError) {
    console.error(`[eip] Connectivity check failed: ${ingestError.message}`);
    process.exit(1);
  }

  const config = { apiKey, supabaseUrl, supabaseAnonKey, serviceName: path.basename(process.cwd()) };
  fs.writeFileSync(path.join(process.cwd(), 'eip.config.json'), JSON.stringify(config, null, 2) + '\n');

  console.log(`\nProject "${project.name}" created and connected.`);
  console.log('Wrote eip.config.json to this directory.\n');
  console.log('Add this to your app entrypoint:\n');
  console.log(`  const eip = require('eip-sdk');`);
  console.log(`  const config = require('./eip.config.json');`);
  console.log(`  const monitor = eip.init(config);`);
  console.log(`  app.use(monitor.middleware());`);
  console.log(`  // ...routes...`);
  console.log(`  app.use(monitor.errorHandler());\n`);

  rl.close();
  await supabase.auth.signOut();
}

main().catch((err) => {
  console.error('[eip] Unexpected error:', err.message);
  process.exit(1);
});
