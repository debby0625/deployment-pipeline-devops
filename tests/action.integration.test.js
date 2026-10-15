import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const testEnv = process.env.TEST_ENV || 'staging';
if (!['staging', 'prod'].includes(testEnv)) throw new Error(`Unsupported TEST_ENV: ${testEnv}`);
const eventLimit = testEnv === 'prod' ? 1 : 2;
const requests = [];
let server, baseUrl, workDir;
const initialReadme = '# Integration fixture\n<!--START_SECTION:activity-->\nold activity\n<!--END_SECTION:activity-->\n';
const fixtureEvents = [
  { type: 'PushEvent', public: true, actor: { login: 'fixture-human' }, repo: { name: 'fixture/public' }, created_at: '2026-10-15T00:00:00Z', payload: { ref: 'refs/heads/main' } },
  { type: 'IssuesEvent', public: false, actor: { login: 'fixture-human' }, repo: { name: 'fixture/private-project' }, created_at: '2026-10-15T00:00:00Z', payload: { action: 'opened', issue: { number: 42 } } },
];

beforeAll(async () => {
  await readFile(resolve('dist/index.js')); // must be the downloaded build artifact
  workDir = await mkdtemp(join(tmpdir(), 'activity-integration-'));
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') { res.statusCode = 405; res.end('{"message":"writes forbidden in integration fixture"}'); return; }
    if (req.url.startsWith('/user/starred')) { res.end('[]'); return; }
    if (req.url.startsWith('/users/fixture-user/events')) { res.end(JSON.stringify(fixtureEvents)); return; }
    res.statusCode = 404; res.end('{"message":"unexpected API endpoint"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`TEST_ENV=${testEnv}; EVENT_LIMIT=${eventLimit}; API=${baseUrl}; artifact=dist/index.js`);
});
afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function runArtifact(overrides = {}) {
  const readmePath = join(workDir, `README-${Date.now()}-${Math.random()}.md`);
  await writeFile(readmePath, initialReadme);
  const env = {
    ...process.env, GITHUB_API_URL: baseUrl, GITHUB_REPOSITORY: 'fixture/activity', GITHUB_REF: 'refs/heads/main',
    INPUT_GITHUB_USERNAME: 'fixture-user', INPUT_GITHUB_TOKEN: 'fixture-token-not-a-secret',
    INPUT_EVENT_LIMIT: String(eventLimit), INPUT_OUTPUT_STYLE: 'MARKDOWN', INPUT_IGNORE_EVENTS: '[]',
    INPUT_HIDE_DETAILS_ON_PRIVATE_REPOS: 'true', INPUT_README_PATH: readmePath,
    INPUT_COMMIT_MESSAGE: 'integration fixture', INPUT_EVENT_EMOJI_MAP: '',
    INPUT_EVENT_TEMPLATE: '{action} {subject} {ref} {number} {verb} [{repo}]({url})', INPUT_DRY_RUN: 'true',
    ...overrides,
  };
  const child = spawn(process.execPath, [resolve('dist/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill(), 12000);
  const [code] = await once(child, 'close'); clearTimeout(timer);
  return { code, output, readme: await readFile(readmePath, 'utf8') };
}

describe('built GitHub Action → HTTP fixture → rendered README preview', () => {
  test('executes the built bundle and preserves the real README in dry-run mode', async () => {
    const result = await runArtifact();
    console.log(result.output);
    expect(result.code).toBe(0);
    expect(result.output).toContain('Committed to main in');
    if (eventLimit === 2) {
      expect(result.output).toContain('Opened issue in a private repository');
      expect(result.output).not.toContain('private-project');
      expect(result.output).not.toContain('#42');
    } else expect(result.output).not.toContain('Opened issue');
    expect(result.readme).toBe(initialReadme);
    expect(requests.some(r => r.url.startsWith('/user/starred'))).toBe(true);
    expect(requests.some(r => r.url.startsWith('/users/fixture-user/events'))).toBe(true);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
  });
  test('supports HTML output through the complete bundle', async () => {
    const result = await runArtifact({ INPUT_OUTPUT_STYLE: 'HTML' });
    expect(result.code).toBe(0);
    expect(result.output).toContain('<ol>');
    expect(result.output).toContain('<li>');
  });
  test('filters ignored events before rendering', async () => {
    const result = await runArtifact({ INPUT_IGNORE_EVENTS: '["PushEvent"]' });
    expect(result.code).toBe(0);
    expect(result.output).not.toContain('Committed to main');
    expect(result.output).toContain('Opened issue in a private repository');
  });
  test('rejects an invalid event limit with a nonzero exit status', async () => {
    const result = await runArtifact({ INPUT_EVENT_LIMIT: '0' });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('EVENT_LIMIT cannot be smaller than 1');
  });
  test('fails when README section markers are missing', async () => {
    const missing = join(workDir, 'missing-markers.md'); await writeFile(missing, '# Missing markers\n');
    const result = await runArtifact({ INPUT_README_PATH: missing });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Section markers not found or invalid');
  });
});
