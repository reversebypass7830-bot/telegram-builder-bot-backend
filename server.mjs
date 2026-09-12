import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const TELEGRAM_BOT_TOKEN = String(process.env.BUILDER_BOT_TELEGRAM_TOKEN || '').trim();
const SUBSCRIPTIONS_FILE = String(
  process.env.BUILDER_SUBSCRIPTIONS_FILE || path.join(os.tmpdir(), 'builder-product-subscriptions.json'),
).trim();
const UPDATE_POLL_MS = Math.max(60_000, Number(process.env.BUILDER_UPDATE_POLL_MS || 300_000));

const jobs = new Map();
const productJobs = new Map();
const subscriptions = new Map();
let subscriptionsLoaded = false;
let updatePollRunning = false;

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
    vercelProjectId: job.vercelProjectId || null,
    vercelDeploymentId: job.vercelDeploymentId || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function updateJob(job, values) {
  Object.assign(job, values, { updatedAt: new Date().toISOString() });
}

function createJob(projectName, id = randomUUID()) {
  return {
    id,
    projectName,
    status: 'queued',
    stage: 'queued',
    configKeys: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function recoverJob(jobId, projectName) {
  const normalizedProjectName = String(projectName || '').trim();
  normalizeRepoName(normalizedProjectName);
  const job = createJob(normalizedProjectName, jobId);
  jobs.set(job.id, job);
  return job;
}

function authOk(req) {
  const acceptedKeys = [API_KEY, TELEBOTHOST_API_KEY].filter(Boolean);
  if (!acceptedKeys.length) return false;
  const provided = String(req.headers['x-backend-key'] || '').trim();
  const authorization = String(req.headers.authorization || '');
  return acceptedKeys.some((key) => provided === key || authorization === `Bearer ${key}`);
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

function configEntries(text) {
  const entries = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/);
    if (match) entries.set(match[1], match[2].trim());
  }
  return entries;
}

function configKeysFrom(text) {
  return [...configEntries(text).keys()];
}

function mergeConfigValues(sourceText, targetText, excludedKeys = []) {
  const preserved = configEntries(targetText);
  const sourceKeys = new Set(configEntries(sourceText).keys());
  const excluded = new Set(excludedKeys);
  const updates = {};
  for (const [key, value] of preserved.entries()) {
    if (sourceKeys.has(key) && !excluded.has(key)) updates[key] = value;
  }
  return applyConfigUpdates(sourceText, updates);
}

function removeConfigKeys(text, keys) {
  const excluded = new Set(keys);
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
      return !match || !excluded.has(match[1]);
    })
    .join('\n');
}

async function readSourceSnapshot() {
  const source = parseRepoSlug(SOURCE_REPO);
  const ref = await githubRequest(
    SOURCE_TOKEN,
    `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/ref/heads/${encodeURIComponent(SOURCE_BRANCH)}`,
  );
  const config = await readConfig(SOURCE_TOKEN, source.owner, source.repo, SOURCE_BRANCH);
  return {
    sha: ref.object?.sha || '',
    configText: config.text,
    configKeys: configKeysFrom(config.text),
    owner: source.owner,
    repo: source.repo,
    branch: SOURCE_BRANCH,
  };
}

async function readTelegramDocument(fileId) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('BUILDER_BOT_TELEGRAM_TOKEN is not configured on the backend.');
  }
  const fileResponse = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/getFile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: String(fileId || '') }),
    },
  );
  const fileBody = await fileResponse.json().catch(() => ({}));
  if (!fileResponse.ok || !fileBody.ok || !fileBody.result?.file_path) {
    throw new Error(fileBody.description || 'Telegram file could not be read.');
  }
  const contentResponse = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileBody.result.file_path}`,
  );
  if (!contentResponse.ok) throw new Error(`Telegram file download failed (${contentResponse.status}).`);
  return contentResponse.text();
}

function parseConfigUpload(text) {
  const updates = {};
  const invalid = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      invalid.push(trimmed.slice(0, 80));
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      invalid.push(key.slice(0, 80));
      continue;
    }
    updates[key] = value;
  }
  if (!Object.keys(updates).length) throw new Error('The uploaded file did not contain any valid KEY=value lines.');
  return { updates, invalid };
}

function subscriptionId(body) {
  const repo = String(body.repository || '').trim();
  const userId = String(body.userId || '').trim();
  if (!repo || !userId) throw new Error('Product repository and user ID are required.');
  return `${userId}:${repo.toLowerCase()}`;
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    userId: subscription.userId,
    chatId: subscription.chatId,
    projectName: subscription.projectName,
    repository: subscription.repository,
    branch: subscription.branch,
    autoUpdate: Boolean(subscription.autoUpdate),
    sourceSha: subscription.sourceSha || null,
    lastAppliedAt: subscription.lastAppliedAt || null,
    scheduledFor: subscription.scheduledFor || null,
    pendingConfigKeys: subscription.pendingConfigKeys || [],
    lastError: subscription.lastError || null,
    backupRef: subscription.backupRef || null,
  };
}

async function loadSubscriptions() {
  if (subscriptionsLoaded) return;
  subscriptionsLoaded = true;
  try {
    const content = await readFile(SUBSCRIPTIONS_FILE, 'utf8');
    const data = JSON.parse(content);
    for (const item of Array.isArray(data) ? data : []) {
      if (item?.id) subscriptions.set(item.id, item);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[backend] subscription state load failed: ${safeError(error)}`);
  }
}

async function saveSubscriptions() {
  await writeFile(SUBSCRIPTIONS_FILE, JSON.stringify([...subscriptions.values()], null, 2));
}

function telegramButtonStyle(text) {
  const label = String(text || '').trim();
  if (/^(Cancel|Delete Product|Confirm Delete|Pause Website|Reject\b|Revert Last Update)/i.test(label)) {
    return 'danger';
  }
  if (/^(Approve\b|DONE$|Update Now$|Add Now$|I have paid$|Resume Website$)/i.test(label)) {
    return 'success';
  }
  return 'primary';
}

function styledTelegramKeyboard(rows) {
  return rows.map((row) =>
    row.map((button) => {
      const text = typeof button === 'string' ? button : String(button?.text || '');
      return {
        ...(typeof button === 'object' && button ? button : {}),
        text,
        style: button?.style || telegramButtonStyle(text),
      };
    }),
  );
}

async function telegramSend(chatId, text, rows = []) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return false;
  const body = { chat_id: String(chatId), text: String(text) };
  if (rows.length) {
    body.reply_markup = {
      keyboard: styledTelegramKeyboard(rows),
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }
  const response = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error(`Telegram notification failed (${response.status}).`);
  return true;
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

async function syncRepositoryWithSource(repository, sourceSnapshot, configValues = {}) {
  const tempRoot = path.join(os.tmpdir(), `builder-update-${randomUUID()}`);
  const worktree = path.join(tempRoot, 'target');
  const source = parseRepoSlug(SOURCE_REPO);
  const targetUrl = `https://github.com/${repository.owner}/${repository.repo}.git`;
  const sourceUrl = `https://github.com/${source.owner}/${source.repo}.git`;
  await mkdir(tempRoot, { recursive: true });

  try {
    await execFileAsync(
      'git',
      ['clone', '--branch', repository.branch, '--single-branch', targetUrl, worktree],
      {
        cwd: tempRoot,
        env: { ...process.env, ...gitAuthEnvironment(TARGET_TOKEN) },
        maxBuffer: 1024 * 1024 * 8,
      },
    );
    const currentConfig = await readFile(path.join(worktree, 'config.txt'), 'utf8').catch(() => '');
    const { stdout: previousSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree });
    const backupRef = `builder-backup-${Date.now()}`;

    await execFileAsync('git', ['remote', 'add', 'source', sourceUrl], {
      cwd: worktree,
      env: { ...process.env, ...gitAuthEnvironment(SOURCE_TOKEN) },
    });
    await execFileAsync('git', ['fetch', 'source', SOURCE_BRANCH], {
      cwd: worktree,
      env: { ...process.env, ...gitAuthEnvironment(SOURCE_TOKEN) },
      maxBuffer: 1024 * 1024 * 8,
    });
    await execFileAsync('git', ['branch', backupRef, 'HEAD'], { cwd: worktree });
    await execFileAsync('git', ['push', 'origin', `${backupRef}:${backupRef}`], {
      cwd: worktree,
      env: { ...process.env, ...gitAuthEnvironment(TARGET_TOKEN) },
    });
    await execFileAsync(
      'git',
      ['read-tree', '--reset', '-u', `source/${SOURCE_BRANCH}`],
      { cwd: worktree },
    );

    const sourceConfigPath = path.join(worktree, 'config.txt');
    const sourceConfig = await readFile(sourceConfigPath, 'utf8').catch(() => sourceSnapshot.configText);
    const oldKeys = new Set(configKeysFrom(currentConfig));
    const sourceKeys = new Set(configKeysFrom(sourceConfig));
    const newKeys = [...sourceKeys].filter((key) => !oldKeys.has(key));
    let mergedConfig = mergeConfigValues(sourceConfig, currentConfig, newKeys);
    mergedConfig = applyConfigUpdates(mergedConfig, configValues);
    await writeFile(sourceConfigPath, mergedConfig);

    await execFileAsync('git', ['config', 'user.email', 'builder-bot@users.noreply.github.com'], { cwd: worktree });
    await execFileAsync('git', ['config', 'user.name', 'Telegram Builder Bot'], { cwd: worktree });
    await execFileAsync('git', ['add', '-A'], { cwd: worktree });
    let newSha = previousSha;
    const stagedStatus = await execFileAsync(
      'git',
      ['diff', '--cached', '--quiet'],
      { cwd: worktree },
    ).then(() => 0).catch((error) => Number(error.code) || 1);
    if (stagedStatus !== 0) {
      await execFileAsync(
        'git',
        ['commit', '-m', `Sync source ${String(sourceSnapshot.sha || '').slice(0, 12)}`],
        { cwd: worktree },
      );
      const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree });
      newSha = result.stdout;
    }
    await execFileAsync('git', ['push', 'origin', `HEAD:${repository.branch}`], {
      cwd: worktree,
      env: { ...process.env, ...gitAuthEnvironment(TARGET_TOKEN) },
      maxBuffer: 1024 * 1024 * 8,
    });

    return {
      previousSha: previousSha.trim(),
      newSha: String(newSha).trim(),
      backupRef,
      newKeys,
      configText: mergedConfig,
    };
  } catch (error) {
    const detail = error?.stderr || error?.message || 'source update failed';
    throw new Error(`Source update failed: ${String(detail).slice(-800)}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function revertRepository(repository, backupRef) {
  const tempRoot = path.join(os.tmpdir(), `builder-revert-${randomUUID()}`);
  const worktree = path.join(tempRoot, 'target');
  const targetUrl = `https://github.com/${repository.owner}/${repository.repo}.git`;
  await mkdir(tempRoot, { recursive: true });
  try {
    await execFileAsync(
      'git',
      ['clone', '--branch', backupRef, '--single-branch', targetUrl, worktree],
      {
        cwd: tempRoot,
        env: { ...process.env, ...gitAuthEnvironment(TARGET_TOKEN) },
        maxBuffer: 1024 * 1024 * 8,
      },
    );
    await execFileAsync('git', ['push', '--force', 'origin', `HEAD:${repository.branch}`], {
      cwd: worktree,
      env: { ...process.env, ...gitAuthEnvironment(TARGET_TOKEN) },
      maxBuffer: 1024 * 1024 * 8,
    });
    const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree });
    return { sha: sha.trim() };
  } catch (error) {
    const detail = error?.stderr || error?.message || 'rollback failed';
    throw new Error(`Rollback failed: ${String(detail).slice(-800)}`);
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
    const error = new Error(data.error?.message || data.message || `Vercel request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function deployRepository(repository) {
  const repoId = String(repository.repoId || '').trim();
  if (!repoId) {
    throw new Error('The GitHub repository ID is missing, so Vercel cannot start the deployment.');
  }
  const configuredProjectId = String(repository.vercelProjectId || VERCEL_PROJECT_ID || '').trim();
  const project = configuredProjectId
    ? await vercelRequest(`/v9/projects/${encodeURIComponent(configuredProjectId)}`)
    : await vercelRequest('/v9/projects', 'POST', {
        name: repository.repo,
        gitRepository: { type: 'github', repo: `${repository.owner}/${repository.repo}` },
      });
  const deployment = await vercelRequest('/v13/deployments', 'POST', {
    name: repository.repo,
    project: project.id || configuredProjectId,
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
  return {
    url: latest.url ? `https://${latest.url}` : deployment.url ? `https://${deployment.url}` : '',
    projectId: project.id || configuredProjectId || '',
    deploymentId: latest.id || deployment.id || '',
  };
}

async function ensureSubscriptionRepository(subscription) {
  const parsed = parseRepoSlug(subscription.repository);
  const details = await githubRequest(
    TARGET_TOKEN,
    `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
  );
  subscription.repository = `${details.owner?.login || parsed.owner}/${details.name || parsed.repo}`;
  subscription.owner = details.owner?.login || parsed.owner;
  subscription.repo = details.name || parsed.repo;
  subscription.repoId = details.id || subscription.repoId;
  subscription.branch = subscription.branch || details.default_branch || SOURCE_BRANCH;
  subscription.htmlUrl = details.html_url || subscription.htmlUrl;
  return subscription;
}

async function productUpdate(subscription, options = {}) {
  await ensureSubscriptionRepository(subscription);
  const source = await readSourceSnapshot();
  const previousSourceSha = subscription.sourceSha || '';
  const currentTarget = await readConfig(
    TARGET_TOKEN,
    subscription.owner,
    subscription.repo,
    subscription.branch,
  );
  const targetKeys = new Set(configKeysFrom(currentTarget.text));
  const newKeys = source.configKeys.filter((key) => !targetKeys.has(key));
  const requestedValues = { ...(options.configValues || {}) };
  if (options.addNewKeys) {
    const sourceValues = configEntries(source.configText);
    for (const key of newKeys) {
      if (requestedValues[key] === undefined) requestedValues[key] = sourceValues.get(key) || '';
    }
  }

  const repository = {
    owner: subscription.owner,
    repo: subscription.repo,
    repoId: subscription.repoId,
    branch: subscription.branch,
    htmlUrl: subscription.htmlUrl,
    vercelProjectId: subscription.vercelProjectId,
  };
  const sync = await syncRepositoryWithSource(repository, source, requestedValues);
  const deployment = await deployRepository(repository);
  subscription.sourceSha = source.sha;
  subscription.lastAppliedAt = new Date().toISOString();
  subscription.pendingConfigKeys = options.addNewKeys ? [] : sync.newKeys;
  subscription.backupRef = sync.backupRef;
  subscription.previousSha = sync.previousSha;
  subscription.lastError = '';
  subscription.lastReason = options.reason || 'manual';
  subscription.vercelProjectId = deployment.projectId || subscription.vercelProjectId || '';
  subscription.vercelDeploymentId = deployment.deploymentId || '';
  subscription.lastDeploymentUrl = deployment.url || subscription.lastDeploymentUrl || '';
  await saveSubscriptions();

  return {
    changed: previousSourceSha !== source.sha || Object.keys(requestedValues).length > 0,
    sourceSha: source.sha,
    newKeys: sync.newKeys,
    addedKeys: Object.keys(requestedValues),
    deploymentUrl: deployment.url,
    backupRef: sync.backupRef,
  };
}

async function productRevert(subscription) {
  await ensureSubscriptionRepository(subscription);
  if (!subscription.backupRef) throw new Error('There is no saved update available to revert.');
  const repository = {
    owner: subscription.owner,
    repo: subscription.repo,
    repoId: subscription.repoId,
    branch: subscription.branch,
    htmlUrl: subscription.htmlUrl,
    vercelProjectId: subscription.vercelProjectId,
  };
  const reverted = await revertRepository(repository, subscription.backupRef);
  const deployment = await deployRepository(repository);
  subscription.lastAppliedAt = new Date().toISOString();
  subscription.lastError = '';
  subscription.lastReason = 'revert';
  subscription.vercelProjectId = deployment.projectId || subscription.vercelProjectId || '';
  subscription.vercelDeploymentId = deployment.deploymentId || '';
  subscription.lastDeploymentUrl = deployment.url || subscription.lastDeploymentUrl || '';
  subscription.backupRef = '';
  subscription.previousSha = reverted.sha;
  await saveSubscriptions();
  return { deploymentUrl: deployment.url, sha: reverted.sha };
}

async function notifyProductUpdate(subscription, result, automatic = false) {
  if (!subscription.chatId) return;
  if (result.newKeys?.length) {
    await telegramSend(
      subscription.chatId,
      `${automatic ? 'A new source update was applied automatically.' : 'A source update is available.'}\n\n` +
        `New configuration values: ${result.newKeys.join(', ')}\n` +
        'Press Add Now to add the source defaults, or Update Now to keep the new code without adding them yet.',
      [['Add Now', 'Update Now'], ['Revert Last Update'], ['My Product']],
    );
  } else {
    await telegramSend(
      subscription.chatId,
      `${automatic ? 'Auto-update complete.' : 'Update complete.'}\n${result.deploymentUrl || ''}`,
      [['My Product'], ['Revert Last Update']],
    );
  }
}

async function runProductJob(job, subscription, action, options = {}) {
  try {
    job.status = 'running';
    job.stage = action === 'revert' ? 'reverting' : 'updating';
    job.updatedAt = new Date().toISOString();
    const result = action === 'revert'
      ? await productRevert(subscription)
      : await productUpdate(subscription, options);
    job.status = 'ready';
    job.stage = 'complete';
    job.result = result;
    job.updatedAt = new Date().toISOString();
    await notifyProductUpdate(subscription, result, Boolean(options.automatic));
  } catch (error) {
    subscription.lastError = safeError(error);
    await saveSubscriptions().catch(() => {});
    job.status = 'failed';
    job.stage = 'failed';
    job.error = safeError(error);
    job.updatedAt = new Date().toISOString();
    if (subscription.chatId) {
      await telegramSend(
        subscription.chatId,
        `Product update failed: ${subscription.lastError}`,
        [['My Product'], ['Check Updates']],
      ).catch(() => {});
    }
  } finally {
    subscription.activeJobId = '';
    await saveSubscriptions().catch(() => {});
  }
}

function startProductJob(subscription, action, options = {}) {
  if (subscription.activeJobId) {
    const existing = productJobs.get(subscription.activeJobId);
    if (existing) return existing;
  }
  const job = {
    id: randomUUID(),
    productId: subscription.id,
    action,
    status: 'queued',
    stage: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  productJobs.set(job.id, job);
  subscription.activeJobId = job.id;
  void runProductJob(job, subscription, action, options);
  return job;
}

async function pollProductUpdates() {
  if (updatePollRunning) return;
  updatePollRunning = true;
  try {
    await loadSubscriptions();
    const source = await readSourceSnapshot();
    const now = Date.now();
    for (const subscription of subscriptions.values()) {
      if (subscription.scheduledFor && Number(subscription.scheduledFor) <= now) {
        subscription.scheduledFor = '';
        startProductJob(subscription, 'update', { reason: 'scheduled' });
      }
      if (!subscription.autoUpdate || subscription.activeJobId) continue;
      if (subscription.sourceSha && subscription.sourceSha !== source.sha) {
        startProductJob(subscription, 'update', { automatic: true, reason: 'automatic' });
      } else if (!subscription.sourceSha) {
        subscription.sourceSha = source.sha;
      }
    }
    await saveSubscriptions();
  } catch (error) {
    console.error(`[backend] product update poll failed: ${safeError(error)}`);
  } finally {
    updatePollRunning = false;
  }
}

async function deleteHostedResources({ vercelProjectId, repository }) {
  const projectId = String(vercelProjectId || '').trim();
  const repositorySlug = String(repository || '').trim();
  if (!projectId || !repositorySlug) {
    throw new Error('The product is missing its Vercel project or repository metadata. Rebuild it before deleting.');
  }

  if (projectId) {
    try {
      await vercelRequest(`/v9/projects/${encodeURIComponent(projectId)}`, 'DELETE');
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  if (repositorySlug) {
    const { owner, repo } = parseRepoSlug(repositorySlug);
    try {
      await githubRequest(
        TARGET_TOKEN,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  return {
    vercelProjectDeleted: Boolean(projectId),
    githubRepositoryDeleted: Boolean(repositorySlug),
  };
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
    updateJob(job, { status: 'deploying', stage: job.repository ? 'updating_repository' : 'creating_repository' });
    if (!job.repository) {
      const repository = await createOrReuseRepository(job.projectName);
      updateJob(job, {
        repository,
        configKeys: repository.configKeys,
      });
    }
    updateJob(job, { stage: 'updating_repository' });
    await updateRepositoryConfig(job.repository, updates);
    updateJob(job, { stage: 'deploying' });
    const deployment = await deployRepository(job.repository);
    updateJob(job, {
      status: 'ready',
      stage: 'complete',
      deploymentUrl: deployment.url,
      vercelProjectId: deployment.projectId,
      vercelDeploymentId: deployment.deploymentId,
    });
  } catch (error) {
    updateJob(job, { status: 'failed', stage: 'failed', error: safeError(error) });
  }
}

async function updateDiscoveryFile() {
  const endpoint = publicBaseUrl();
  if (!endpoint || !TARGET_TOKEN) return;
  const { owner, repo } = parseRepoSlug(BACKEND_REPO);
  let current = {};
  try {
    const currentResponse = await githubRequest(TARGET_TOKEN, `/repos/${owner}/${repo}/contents/${DISCOVERY_FILE}`);
    let document = {};
    try {
      document = JSON.parse(decodeContent(currentResponse.content));
    } catch {
      document = {};
    }
    current = { sha: currentResponse.sha, document };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const provider = providerName();
  if (current.document?.url === endpoint && current.document?.provider === provider) {
    console.log('[backend] discovery file is already current; skipping GitHub commit.');
    return;
  }
  const document = {
    url: endpoint,
    version: 1,
    updatedAt: new Date().toISOString(),
    provider,
  };
  await githubRequest(TARGET_TOKEN, `/repos/${owner}/${repo}/contents/${DISCOVERY_FILE}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Update backend endpoint for ${provider || 'host'}`,
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
    const job = createJob(projectName);
    jobs.set(job.id, job);
    void runBuild(job);
    return json(res, 202, { ok: true, build: publicJob(job) });
  }

  if (req.method === 'POST' && parsed.pathname === '/v1/config/import') {
    const text = await readTelegramDocument(body.fileId);
    const parsedConfig = parseConfigUpload(text);
    return json(res, 200, { ok: true, updates: parsedConfig.updates, invalid: parsedConfig.invalid });
  }

  if (req.method === 'POST' && parsed.pathname === '/v1/products/register') {
    await loadSubscriptions();
    const id = subscriptionId(body);
    const existing = subscriptions.get(id) || {};
    const subscription = {
      ...existing,
      id,
      userId: String(body.userId || existing.userId || ''),
      chatId: String(body.chatId || existing.chatId || body.userId || ''),
      projectName: String(body.projectName || existing.projectName || 'Website'),
      repository: String(body.repository || existing.repository || ''),
      branch: String(body.branch || existing.branch || SOURCE_BRANCH),
      repoId: body.repoId || existing.repoId || '',
      htmlUrl: String(body.htmlUrl || existing.htmlUrl || body.repository || ''),
      vercelProjectId: String(body.vercelProjectId || existing.vercelProjectId || ''),
      autoUpdate: body.autoUpdate === undefined ? Boolean(existing.autoUpdate) : Boolean(body.autoUpdate),
      pendingConfigKeys: existing.pendingConfigKeys || [],
      sourceSha: existing.sourceSha || '',
      lastAppliedAt: existing.lastAppliedAt || null,
      scheduledFor: existing.scheduledFor || '',
      backupRef: existing.backupRef || '',
      activeJobId: existing.activeJobId || '',
      lastError: '',
    };
    await ensureSubscriptionRepository(subscription);
    if (!subscription.sourceSha) {
      const source = await readSourceSnapshot();
      subscription.sourceSha = source.sha;
    }
    subscriptions.set(id, subscription);
    await saveSubscriptions();
    return json(res, 200, { ok: true, product: publicSubscription(subscription) });
  }

  if (req.method === 'POST' && parsed.pathname === '/v1/products/settings') {
    await loadSubscriptions();
    const id = subscriptionId(body);
    const subscription = subscriptions.get(id);
    if (!subscription) return json(res, 404, { ok: false, error: 'Product is not registered.' });
    if (body.autoUpdate !== undefined) subscription.autoUpdate = Boolean(body.autoUpdate);
    if (body.scheduledFor !== undefined) subscription.scheduledFor = body.scheduledFor || '';
    await saveSubscriptions();
    return json(res, 200, { ok: true, product: publicSubscription(subscription) });
  }

  if (req.method === 'POST' && parsed.pathname === '/v1/products/check') {
    await loadSubscriptions();
    const id = subscriptionId(body);
    const subscription = subscriptions.get(id);
    if (!subscription) return json(res, 404, { ok: false, error: 'Product is not registered.' });
    await ensureSubscriptionRepository(subscription);
    const source = await readSourceSnapshot();
    const target = await readConfig(TARGET_TOKEN, subscription.owner, subscription.repo, subscription.branch);
    const targetKeys = new Set(configKeysFrom(target.text));
    const newKeys = source.configKeys.filter((key) => !targetKeys.has(key));
    const changed = Boolean(subscription.sourceSha && subscription.sourceSha !== source.sha);
    subscription.pendingConfigKeys = newKeys;
    await saveSubscriptions();
    return json(res, 200, {
      ok: true,
      changed,
      sourceSha: source.sha,
      currentSourceSha: subscription.sourceSha || null,
      newKeys,
      autoUpdate: Boolean(subscription.autoUpdate),
      scheduledFor: subscription.scheduledFor || null,
    });
  }

  if (req.method === 'POST' && parsed.pathname === '/v1/products/update') {
    await loadSubscriptions();
    const id = subscriptionId(body);
    const subscription = subscriptions.get(id);
    if (!subscription) return json(res, 404, { ok: false, error: 'Product is not registered.' });
    const action = body.action === 'revert' ? 'revert' : 'update';
    const job = startProductJob(subscription, action, {
      addNewKeys: Boolean(body.addNewKeys),
      configValues: body.configValues || {},
      reason: body.reason || 'manual',
    });
    await saveSubscriptions();
    return json(res, 202, { ok: true, job: { id: job.id, status: job.status, stage: job.stage } });
  }

  const productJobMatch = parsed.pathname.match(/^\/v1\/products\/updates\/([^/]+)$/);
  if (req.method === 'GET' && productJobMatch) {
    const job = productJobs.get(productJobMatch[1]);
    if (!job) return json(res, 404, { ok: false, error: 'Product update job not found.' });
    return json(res, 200, { ok: true, job });
  }

  if (req.method === 'POST' && parsed.pathname === '/v1/products/delete') {
    const result = await deleteHostedResources({
      vercelProjectId: body.vercelProjectId,
      repository: body.repository,
    });
    return json(res, 200, { ok: true, deleted: result });
  }

  const match = parsed.pathname.match(/^\/v1\/builds\/([^/]+)(\/deploy)?$/);
  if (req.method === 'GET' && match && !match[2]) {
    let job = jobs.get(match[1]);
    if (!job) {
      const projectName = parsed.searchParams.get('projectName');
      if (!projectName) return json(res, 404, { ok: false, error: 'Build not found.' });
      job = recoverJob(match[1], projectName);
      void runBuild(job);
      return json(res, 202, { ok: true, build: publicJob(job), recovered: true });
    }
    return json(res, 200, { ok: true, build: publicJob(job) });
  }
  if (req.method === 'POST' && match && match[2] === '/deploy') {
    const jobId = match[1];
    let job = jobs.get(jobId);
    if (!job) {
      const projectName = String(body.projectName || '').trim();
      if (!projectName) return json(res, 404, { ok: false, error: 'Build not found.' });
      job = recoverJob(jobId, projectName);
      void runDeployment(job, body.updates || {});
      return json(res, 202, { ok: true, build: publicJob(job), recovered: true });
    }
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
  void loadSubscriptions().then(() => pollProductUpdates());
  setInterval(() => {
    void pollProductUpdates();
  }, UPDATE_POLL_MS);
  const endpoint = publicBaseUrl();
  void updateDiscoveryFile().catch((error) => {
    console.error(`[backend] discovery update failed: ${safeError(error)}`);
  });
  void updateTeleBotHostEnvironment(endpoint).catch((error) => {
    console.error(`[backend] TeleBotHost URL sync failed: ${safeError(error)}`);
  });
});