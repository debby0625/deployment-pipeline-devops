const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function manifest() {
  const data = { commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID,
    archive: hash('build.tar'), bundle: hash('dist/index.js') };
  fs.writeFileSync('build-manifest.json', JSON.stringify(data, null, 2) + '\n');
  console.log('Build manifest:', JSON.stringify(data));
}
function restore() {
  const data = JSON.parse(fs.readFileSync('build-manifest.json', 'utf8'));
  if (data.commit !== process.env.GITHUB_SHA) throw new Error('Artifact commit mismatch');
  if (hash('build.tar') !== data.archive) throw new Error('Artifact archive checksum mismatch');
  fs.rmSync('dist', { recursive: true, force: true });
  execFileSync('tar', ['-xf', 'build.tar']);
  if (hash('dist/index.js') !== data.bundle) throw new Error('Built bundle checksum mismatch');
  console.log(`Verified artifact from commit ${data.commit}; SHA256 ${data.archive}`);
}
function scenario(phase) {
  const value = process.env.SCENARIO || 'success';
  console.log(`Verification scenario=${value}; phase=${phase}; TEST_ENV=${process.env.TEST_ENV}`);
  if (value === 'unit-failure' && phase === 'unit') {
    const path = 'src/utils/templateEngine.js';
    const before = "const repoName = isPrivate ? 'a private repository' : repo.name;";
    const text = fs.readFileSync(path, 'utf8');
    if (!text.includes(before)) throw new Error('Unit mutation target missing');
    fs.writeFileSync(path, text.replace(before, 'const repoName = repo.name;'));
    console.log('DELIBERATE NEGATIVE CONTROL: private-name hiding removed in this disposable runner.');
  }
  if (value === 'coverage-failure' && phase === 'unit') {
    fs.unlinkSync('tests/templateEngine.edges.test.js');
    console.log('DELIBERATE NEGATIVE CONTROL: omit edge-case tests; keep thresholds unchanged.');
  }
  if (value === 'integration-failure' && phase === 'integration') {
    const path = 'dist/index.js'; const text = fs.readFileSync(path, 'utf8');
    if (!text.includes('a private repository')) throw new Error('Bundle mutation target missing');
    fs.writeFileSync(path, text.replaceAll('a private repository', 'EXPOSED_PRIVATE_REPO'));
    console.log('DELIBERATE NEGATIVE CONTROL: corrupt privacy rendering in unpacked bundle only.');
  }
}
async function notify({ github, context, core }) {
  const repo = context.repo;
  const results = JSON.parse(process.env.JOB_RESULTS);
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const rows = Object.entries(results).map(([name, job]) => `| ${name} | ${job.result} |`).join('\n');
  const success = ['build', 'test-unit', 'test-integration'].every(n => results[n]?.result === 'success');
  const body = `## Automated test result: ${success ? 'PASS' : 'FAIL / BLOCKED'}\n\n` +
    `Run: [#${context.runNumber}](${runUrl})\nCommit: \`${context.sha}\`\n` +
    `Scenario: \`${process.env.SCENARIO}\`\n\n| Stage | Result |\n|---|---|\n${rows}\n\n` +
    'Unit matrix: Ubuntu / Windows × Node 22 / 24. Integration: TEST_ENV=staging / prod.\n' +
    'Coverage and JUnit reports are attached to the workflow run. Failed tests or coverage block every release.\n' +
    `<!-- assignment5-result:${context.runId}:${process.env.GITHUB_RUN_ATTEMPT} -->`;
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'open', creator: 'github-actions[bot]', per_page: 100 });
  let tracker = issues.find(i => i.title === '[CI] Automated test results');
  if (!tracker) tracker = (await github.rest.issues.create({ ...repo, title: '[CI] Automated test results',
    body: 'Test notifications for Assignment 5. Each comment links to the actual run and reports stage results. This tracking issue is separate from automatically created failure issues.' })).data;
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: tracker.number, per_page: 100 });
  const marker = `<!-- assignment5-result:${context.runId}:${process.env.GITHUB_RUN_ATTEMPT} -->`;
  let comment = comments.find(c => c.body?.includes(marker));
  if (!comment) comment = (await github.rest.issues.createComment({ ...repo, issue_number: tracker.number, body })).data;
  console.log('Notification delivered:', comment.html_url);
  await core.summary.addHeading('Test result notification').addLink('GitHub issue comment', comment.html_url).write();
  if (!success && Object.values(results).some(j => j.result === 'failure')) {
    const title = `[CI failure] ${process.env.SCENARIO} — run #${context.runNumber}`;
    let failure = issues.find(i => i.title === title);
    if (!failure) failure = (await github.rest.issues.create({ ...repo, title, body })).data;
    console.log('Automatic failure issue:', failure.html_url);
    await core.summary.addLink('Automatically created failure issue', failure.html_url).write();
  }
}
async function badges({ github, context, core }) {
  const repo = context.repo, ref = 'ci-status';
  const results = JSON.parse(process.env.JOB_RESULTS);
  const combine = names => names.some(n => results[n]?.result === 'failure') ? 'failure' :
    names.every(n => results[n]?.result === 'success') ? 'success' : 'skipped';
  const states = { Build: combine(['build']), Test: combine(['test-unit', 'test-integration']),
    Release: combine(['deploy-dev', 'deploy-staging', 'ai-release-notes', 'deploy-production']) };
  let branch;
  try { branch = (await github.rest.git.getRef({ ...repo, ref: `heads/${ref}` })).data; }
  catch (e) {
    if (e.status !== 404) throw e;
    branch = (await github.rest.git.createRef({ ...repo, ref: `refs/heads/${ref}`, sha: context.sha })).data;
  }
  const current = (await github.rest.git.getCommit({ ...repo, commit_sha: branch.object.sha })).data;
  const previous = await github.rest.repos.getContent({ ...repo, path: 'latest.json', ref }).catch(e => { if (e.status !== 404) throw e; return null; });
  if (previous && JSON.parse(Buffer.from(previous.data.content, 'base64').toString()).runNumber > context.runNumber) {
    console.log('Newer run already published badges; preserve it.'); return;
  }
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const files = Object.entries(states).map(([label, state]) => ({ path: `${label.toLowerCase()}.json`, mode: '100644', type: 'blob',
    content: JSON.stringify({ schemaVersion: 1, label, message: state, color: state === 'success' ? 'brightgreen' : state === 'failure' ? 'red' : 'lightgrey', cacheSeconds: 300 }) + '\n' }));
  files.push({ path: 'latest.json', mode: '100644', type: 'blob', content: JSON.stringify({ runNumber: context.runNumber, runUrl, commit: context.sha, scenario: process.env.SCENARIO, states }, null, 2) + '\n' });
  const tree = (await github.rest.git.createTree({ ...repo, base_tree: current.tree.sha, tree: files })).data;
  const commit = (await github.rest.git.createCommit({ ...repo, message: `CI status for run #${context.runNumber}`, tree: tree.sha, parents: [current.sha] })).data;
  await github.rest.git.updateRef({ ...repo, ref: `heads/${ref}`, sha: commit.sha });
  console.log('Published actual stage statuses:', JSON.stringify(states));
  await core.summary.addHeading('Build / Test / Release badges').addCodeBlock(JSON.stringify({ runUrl, ...states }, null, 2)).write();
}
module.exports = { notify, badges };
if (require.main === module) {
  const command = process.argv[2];
  if (command === 'manifest') manifest();
  else if (command === 'restore') restore();
  else if (command === 'scenario') scenario(process.argv[3]);
  else throw new Error('Unknown CI command');
}
