import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = String(process.env.BUILDER_BACKEND_API_KEY || '').trim();
const SOURCE_REPO = String(process.env.BUILDER_SOURCE_REPO || 'instaboosterwesd/rgxpanel.in').trim();
const SOURCE_BRANCH = String(process.env.BUILDER_SOURCE_BRANCH || 'main').trim();
const SOURCE_TOKEN = String(process.env.BUILDER_GITHUB_SOURCE_TOKEN || '').trim();
const TARGET_TOKEN = String(process.env.BUILDER_GITHUB_TARGET_TOKEN || '').trim();
const VERCEL_TOKEN = String(process.env.BUILDER_VERCEL_TOKEN || '').trim();
const VERCEL_TEAM_ID = String(process.env.BUILDER_VERCEL_TEAM_ID || '').trim();
const VERCEL_PROJECT_ID = String(process.env.BUILDER_VERCEL_PROJECT_ID || '').trim();
const BACKEND_REPO = String(
  process.env.BUILDER_BACKEND_REPO || 'reversebypass7830-bot/telegram-builder-bot-backend',
).trim();
const DISCOVERY_FILE = String(
  process.env.BUILDER_BACKEND_DISCOVERY_FILE || 'backend-endpoint.json',
).trim();
const TELEBOTHOST_API_BASE = String(
  process.env.BUILDER_TELEBOTHOST_API_BASE || 'https://api.telebothost.com/api/v1',
).replace(/\/+$/, '');
const TELEBOTHOST_API_KEY = String(process.env.BUILDER_TELEBOTHOST_API_KEY || '').trim();
const TELEBOTHOST_BOT_ID = String(
  process.env.BUILDER_TELEBOTHOST_BOT_ID || '377965775095836',
).trim();
const TELEBOTHOST_ENV_NAME = String(
  process.env.BUILDER_TELEBOTHOST_ENV_NAME || 'BUILDER_BACKEND_URL',
).trim();

const jobs = new Map();

function parseRepoSlug(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const match = normalized.match(/^([^/]+)\/([^/]+)$/);
  if (!match) throw new Error('Repository must use owner/name format.');
  return { owner: match[1], repo: match[2] };
}

function normalizeRepoName(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  if (!normalized || normalized.length < 2) {
    throw new Error('Project name must contain at least two letters or numbers.');
  }
  return normalized.slice(0, 90);
}

function publicBaseUrl() {
  const explicit = String(process.env.BACKEND_PUBLIC_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const candidates = [
    process.env.RAILWAY_PUBLIC_DOMAIN,
    process.env.RAILWAY_STATIC_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL,
    process.env.VERCEL_URL,
  ];
  const value = candidates.find((item) => String(item || '').trim());
  if (!value) return '';
  const normalized = String(value).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
}

function providerName() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL) return 'railway';
  if (process.env.VERCEL_URL) return 'vercel';
  return process.env.PUBLIC_URL || process.env.APP_URL ? 'custom' : null;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function publicJob(job) {
  return {
    id: job.id,
    projectName: job.projectName,
    status: job.status,
    stage: job.stage,
    error: job.error || null,
    repository: job.repository || null,
    configKeys: job.configKeys || [],
    deploymentUrl: job.deploymentUrl || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function updateJob(job, values) {
  Object.assign(job, values, { updatedAt: new Date().toISOString() });
}

function authOk(req) {
  if (!API_KEY) return false;
  const provided = String(req.headers['x-backend-key'] || '').trim();
  const authorization = String(req.headers.authorization || '');
  return provided === API_KEY || authorization === `Bearer ${API_KEY}`;
}

async function githubRequest(token, route, options = {}) {
  if (!token) throw new Error('GitHub credentials are not configured on the backend.');
  const response = await fetch(`https://api.github.com${route}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 300) };
  }
  if (!response.ok) {
    const error = new Error(body.message || `GitHub request failed (${response.status}).`);
    error.status = response.status;
    error.route = route;
    throw error;
  }
  return body;
}

async function teleBotHostRequest(route, options = {}) {
  if (!TELEBOTHOST_API_KEY) {
    throw new Error('BUILDER_TELEBOTHOST_API_KEY is not configured.');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${TELEBOTHOST_API_BASE}${route}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': TELEBOTHOST_API_KEY,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text.slice(0, 300) };
    }

    if (response.ok && body?.success !== false) return body;
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after') || 10);
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, retryAfter) * 1000));
      continue;
    }

    const reason = body?.reason || body?.message || `TeleBotHost request failed (${response.status}).`;
    throw new Error(String(reason).slice(0, 300));
  }

  throw new Error('TeleBotHost request quota retry limit reached.');
}

function decodeContent(content) {
  return Buffer.from(String(content || '').replace(/\n/g, ''), 'base64').toString('utf8');
}

function encodeContent(content) {
  return Buffer.from(String(content || ''), 'utf8').toString('base64');
}

function configKeys(text) {
  const keys = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      keys.push(match[1]);
    }
  }
  return keys;
}

function applyConfigUpdates(text, updates) {
  const lines = String(text || '').split(/\r?\n/);
  const lastLineByKey = new Map();
  lines.forEach((line, index) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
    if (match) lastLineByKey.set(match[1], index);
  });
  for (const [key, value] of Object.entries(updates || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    const safeValue = String(value ?? '').replace(/\r?\n/g, ' ').trim();
    if (lastLineByKey.has(key)) lines[lastLineByKey.get(key)] = `${key}=${safeValue}`;
    else lines.push(`${key}=${safeValue}`);
  }
  return lines.join('\n');
}

function gitAuthEnvironment(token) {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

async function mirrorRepository(sourceToken, targetToken, sourceRepo, targetOwner, targetRepo) {
  const tempRoot = path.join(os.tmpdir(), `builder-backend-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true });
  const mirrorPath = path.join(tempRoot, 'source.git');
  const source = parseRepoSlug(sourceRepo);
  const sourceUrl = `https://github.com/${source.owner}/${source.repo}.git`;
  const targetUrl = `https://github.com/${targetOwner}/${targetRepo}.git`;
  try {
    await execFileAsync('git', ['clone', '--mirror', sourceUrl, mirrorPath], {
      cwd: tempRoot,
      env: { ...process.env, ...gitAuthEnvironment(sourceToken) },
      maxBuffer: 1024 * 1024 * 8,
    });
    await execFileAsync('git', ['push', '--mirror', targetUrl], {
      cwd: mirrorPath,
      env: { ...process.env, ...gitAuthEnvironment(targetToken) },
      maxBuffer: 1024 * 1024 * 8,
    });
  } catch (error) {
    const detail = error?.stderr || error?.message || 'mirror operation failed';
    throw new Error(`Repository mirror failed: ${String(detail).slice(-800)}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function readConfig(token, owner, repo, branch) {
  const file = await githubRequest(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/config.txt?ref=${encodeURIComponent(branch)}`,
  );
  return {
    sha: file.sha,
    text: decodeContent(file.content),
  };
}

async function createOrReuseRepository(projectName) {
  const source = parseRepoSlug(SOURCE_REPO);
  const targetUser = await githubRequest(TARGET_TOKEN, '/user');
  const repoName = normalizeRepoName(projectName);
  let repository;
  let creationMode = 'existing';

  try {
    repository = await githubRequest(
      TARGET_TOKEN,
      `/repos/${encodeURIComponent(targetUser.login)}/${encodeURIComponent(repoName)}`,
    );
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  if (!repository) {
    const sourceDetails = await githubRequest(
      SOURCE_TOKEN,
      `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`,
    );
    repository = await githubRequest(TARGET_TOKEN, '/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        private: Boolean(sourceDetails.private),
        description: sourceDetails.description || 'Built by Telegram Builder Bot',
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      }),
    });
    creationMode = 'mirror';
    await mirrorRepository(SOURCE_TOKEN, TARGET_TOKEN, SOURCE_REPO, targetUser.login, repoName);
  }

  if (creationMode === 'existing' && Number(repository.size || 0) === 0) {
    throw new Error(
      `The target repository ${repoName} already exists but is empty. Choose another project name or remove the empty repository.`,
    );
  }

  const owner = repository.owner?.login || targetUser.login;
  const repo = repository.name || repoName;
  const branch = repository.default_branch || SOURCE_BRANCH;
  const template = await readConfig(
    creationMode === 'mirror' ? SOURCE_TOKEN : TARGET_TOKEN,
    creationMode === 'mirror' ? source.owner : owner,
    creationMode === 'mirror' ? source.repo : repo,
    creationMode === 'mirror' ? SOURCE_BRANCH : branch,
  );

  return {
    owner,
    repo,
    repoId: repository.id,
    branch,
    htmlUrl: repository.html_url || `https://github.com/${owner}/${repo}`,
    creationMode,
    configKeys: configKeys(template.text),
  };
}

async function updateRepositoryConfig(repository, updates) {
  if (!updates || !Object.keys(updates).length) return;
  const current = await readConfig(TARGET_TOKEN, repository.owner, repository.repo, repository.branch);
  const updatedText = applyConfigUpdates(current.text, updates);
  await githubRequest(
    TARGET_TOKEN,
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/config.txt`,
    {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Update project configuration',
        content: encodeContent(updatedText),
        sha: current.sha,
        branch: repository.branch,
      }),
    },
  );
}

function vercelRoute(route) {
  if (!VERCEL_TEAM_ID) return route;
  return `${route}${route.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
}

async function vercelRequest(route, method = 'GET', body) {
  if (!VERCEL_TOKEN) throw new Error('BUILDER_VERCEL_TOKEN is not configured on the backend.');
  const response = await fetch(`https://api.vercel.com${vercelRoute(route)}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.message || `Vercel request failed (${response.status}).`);
  }
  return data;
}

async function deployRepository(repository) {
  const repoId = String(repository.repoId || '').trim();
  if (!repoId) {
    throw new Error('The GitHub repository ID is missing, so Vercel cannot start the deployment.');
  }
  const project = VERCEL_PROJECT_ID
    ? await vercelRequest(`/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}`)
    : await vercelRequest('/v9/projects', 'POST', {
        name: repository.repo,
        gitRepository: { type: 'github', repo: `${repository.owner}/${repository.repo}` },
      });
  const deployment = await vercelRequest('/v13/deployments', 'POST', {
    name: repository.repo,
    project: project.id || VERCEL_PROJECT_ID,
    target: 'production',
    gitSource: { type: 'github', repoId, ref: repository.branch },
  });
  let latest = deployment;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await vercelRequest(`/v13/deployments/${encodeURIComponent(deployment.id)}`);
    if (['READY', 'ERROR', 'CANCELED', 'BLOCKED'].includes(latest.readyState)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (latest.readyState !== 'READY') {
    throw new Error(latest.errorMessage || `Vercel deployment ended in ${latest.readyState || 'failed'} state.`);
  }
  return latest.url ? `https://${latest.url}` : deployment.url ? `https://${deployment.url}` : '';
}

async function runBuild(job) {
  try {
    updateJob(job, { status: 'running', stage: 'creating_repository' });
    const repository = await createOrReuseRepository(job.projectName);
    updateJob(job, {
      status: 'ready',
      stage: 'awaiting_configuration',
      repository,
      configKeys: repository.configKeys,
    });
  } catch (error) {
    updateJob(job, { status: 'failed', stage: 'failed', error: safeError(error) });
  }
}

async function runDeployment(job, updates) {
  try {
    updateJob(job, { status: 'deploying', stage: 'updating_repository' });
    await updateRepositoryConfig(job.repository, updates);
    updateJob(job, { stage: 'deploying' });
    const deploymentUrl = await deployRepository(job.repository);
    updateJob(job, {
      status: 'ready',
      stage: 'complete',
      deploymentUrl,
    });
  } catch (error) {
    updateJob(job, { status: 'failed', stage: 'failed', error: safeError(error) });
  }
}

async function updateDiscoveryFile() {
  const endpoint = publicBaseUrl();
  if (!endpoint || !TARGET_TOKEN) return;
  const { owner, repo } = parseRepoSlug(BACKEND_REPO);
  const filePath = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${DISCOVERY_FILE}`;
  let current = {};
  try {
    const currentResponse = await githubRequest(TARGET_TOKEN, `/repos/${owner}/${repo}/contents/${DISCOVERY_FILE}`);
    current = { sha: currentResponse.sha };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const document = {
    url: endpoint,
    version: 1,
    updatedAt: new Date().toISOString(),
    provider: providerName(),
  };
  await githubRequest(TARGET_TOKEN, `/repos/${owner}/${repo}/contents/${DISCOVERY_FILE}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Update backend endpoint for ${providerName() || 'host'}`,
      content: encodeContent(`${JSON.stringify(document, null, 2)}\n`),
      ...(current.sha ? { sha: current.sha } : {}),
      branch: 'main',
    }),
  });
}

async function updateTeleBotHostEnvironment(endpoint) {
  if (!endpoint) return;
  if (!TELEBOTHOST_API_KEY) {
    console.log('[backend] TeleBotHost URL sync skipped: API key is not configured.');
    return;
  }

  const current = await teleBotHostRequest(`/bot/${encodeURIComponent(TELEBOTHOST_BOT_ID)}/envs`);
  const environments = Array.isArray(current.envs) ? current.envs : [];
  const existing = environments.find((item) => item.name === TELEBOTHOST_ENV_NAME);
  const body = { value: endpoint };

  if (existing?.id) {
    await teleBotHostRequest(
      `/bot/${encodeURIComponent(TELEBOTHOST_BOT_ID)}/envs/${encodeURIComponent(existing.id)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
  } else {
    await teleBotHostRequest(
      `/bot/${encodeURIComponent(TELEBOTHOST_BOT_ID)}/envs`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: TELEBOTHOST_ENV_NAME,
          ...body,
          placeholder: 'Builder backend public URL',
        }),
      },
    );
  }

  console.log(`[backend] TeleBotHost environment updated: ${TELEBOTHOST_ENV_NAME}`);
}

async function handle(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && parsed.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'telegram-builder-bot-backend', provider: providerName() });
  }
  if (req.method === 'GET' && parsed.pathname === '/discovery') {
    return json(res, 200, { ok: true, url: publicBaseUrl(), provider: providerName() });
  }
  if (!authOk(req)) return json(res, 401, { ok: false, error: 'Unauthorized backend request.' });

  let body = {};
  if (req.method !== 'GET') {
    const raw = await new Promise((resolve, reject) => {
      let value = '';
      req.on('data', (chunk) => { value += chunk; });
      req.on('end', () => resolve(value));
      req.on('error', reject);
    });
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { ok: false, error: 'Request body must be valid JSON.' });
    }
  }

  if (req.method === 'POST' && parsed.pathname === '/v1/builds') {
    const projectName = String(body.projectName || '').trim();
    normalizeRepoName(projectName);
    const job = {
      id: randomUUID(),
      projectName,
      status: 'queued',
      stage: 'queued',
      configKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    void runBuild(job);
    return json(res, 202, { ok: true, build: publicJob(job) });
  }

  const match = parsed.pathname.match(/^\/v1\/builds\/([^/]+)(\/deploy)?$/);
  if (req.method === 'GET' && match && !match[2]) {
    const job = jobs.get(match[1]);
    return job ? json(res, 200, { ok: true, build: publicJob(job) }) : json(res, 404, { ok: false, error: 'Build not found.' });
  }
  if (req.method === 'POST' && match && match[2] === '/deploy') {
    const jobId = match[1];
    const job = jobs.get(jobId);
    if (!job) return json(res, 404, { ok: false, error: 'Build not found.' });
    if (job.status !== 'ready' || job.stage !== 'awaiting_configuration') {
      return json(res, 409, { ok: false, error: `Build is not ready for deployment (${job.status}/${job.stage}).` });
    }
    updateJob(job, { status: 'deploying', stage: 'queued_deployment' });
    void runDeployment(job, body.updates || {});
    return json(res, 202, { ok: true, build: publicJob(job) });
  }
  return json(res, 404, { ok: false, error: 'Route not found.' });
}

const server = await import('node:http').then(({ createServer }) =>
  createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(`[backend] ${safeError(error)}`);
      json(res, 500, { ok: false, error: safeError(error) });
    });
  }),
);

server.listen(PORT, HOST, () => {
  console.log(`Builder backend listening on ${HOST}:${PORT}`);
  const endpoint = publicBaseUrl();
  void updateDiscoveryFile().catch((error) => {
    console.error(`[backend] discovery update failed: ${safeError(error)}`);
  });
  void updateTeleBotHostEnvironment(endpoint).catch((error) => {
    console.error(`[backend] TeleBotHost URL sync failed: ${safeError(error)}`);
  });
});