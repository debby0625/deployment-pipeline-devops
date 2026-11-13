import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const workflowDirectory = process.argv[2] ?? '.github/workflows';
const workflows = readdirSync(workflowDirectory).filter(name => /\.ya?ml$/.test(name));
const violations = [];
const deploymentPermissions = {
  'notify-tests': { issues: 'write' },
  'deploy-dev': { contents: 'write' },
  'deploy-staging': { contents: 'write' },
  'deploy-production': { contents: 'write' },
  'publish-status': { contents: 'write' },
};

function checkAction(reference, location) {
  if (!reference || reference.startsWith('./')) return;
  if (!/^[^@]+@[0-9a-f]{40}$/.test(reference)) {
    violations.push(`${location}: pin ${reference} to a full 40-character commit SHA`);
  }
}

for (const file of workflows) {
  const { permissions, jobs } = parse(readFileSync(join(workflowDirectory, file), 'utf8'));
  if (Object.keys(permissions ?? {}).length !== 0 || !permissions) {
    violations.push(`${file}: declare permissions: {} and grant access per job`);
  }
  for (const [name, job] of Object.entries(jobs)) {
    const location = `${file}:${name}`;
    const allowed = {
      contents: 'read',
      ...(file === 'deployment.yml' ? deploymentPermissions[name] : {}),
    };
    if (!job.permissions || typeof job.permissions !== 'object' ||
        Object.entries(job.permissions).some(([scope, access]) => access !== allowed[scope])) {
      violations.push(`${location}: declare job permissions within ${JSON.stringify(allowed)}`);
    }
    checkAction(job.uses, location);
    for (const step of job.steps ?? []) checkAction(step.uses, location);
  }
}

if (workflows.length === 0) violations.push(`${workflowDirectory}: no workflows to verify`);
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Verified ${workflows.length} workflow file(s): full action SHAs and job permissions.`);
}
