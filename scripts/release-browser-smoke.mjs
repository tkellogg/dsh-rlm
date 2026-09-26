#!/usr/bin/env node
// Real-Chrome smoke for an extracted dsh-rlm native app.
//
// Required:
//   DSH_RLM_BROWSER_APP_DIR=/absolute/path/to/extracted/app
//   DSH_RLM_BROWSER_PYTHON=/absolute/path/to/python
// Optional:
//   DSH_RLM_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs (default: playwright)
//   DSH_RLM_BROWSER_EXECUTABLE=/Applications/.../Google Chrome
//   DSH_RLM_BROWSER_WHEEL=/absolute/path/to/dsh_rlm.whl (launch exact wheel via uv)
//   DSH_RLM_BROWSER_UV=/absolute/path/to/uv (default: uv)
//   DSH_RLM_BROWSER_PORT=3182
//   DSH_RLM_BROWSER_WORK_PARENT=/private/temp/parent
//   DSH_RLM_BROWSER_LOG_DIR=/private/temp/private-logs
//
// The script starts two isolated app instances with fresh DSH_RLM_HOME values,
// uses separate incognito BrowserContexts for API-provider and subscription
// navigation, never prints authenticated launch URLs, and retains private logs
// plus screenshots for release evidence.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const required = (name, fallback) => {
  const value = env[name] || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const appDir = resolve(required('DSH_RLM_BROWSER_APP_DIR', env.DSH_RLM_APP_DIR));
const python = resolve(required('DSH_RLM_BROWSER_PYTHON', env.DSH_RLM_PYTHON));
const node = join(appDir, 'runtime/node/bin/node');
const launcher = join(appDir, 'launcher/cli.mjs');
await Promise.all([access(node), access(launcher), access(python)]);

const basePort = Number(env.DSH_RLM_BROWSER_PORT || 3182);
assert.ok(Number.isInteger(basePort) && basePort > 0 && basePort < 65535,
  'DSH_RLM_BROWSER_PORT must leave room for two TCP ports');
const workParent = resolve(env.DSH_RLM_BROWSER_WORK_PARENT || tmpdir());
await mkdir(workParent, { recursive: true, mode: 0o700 });
const workDir = await mkdtemp(join(workParent, 'dsh-rlm-browser-smoke.'));
const logDir = resolve(env.DSH_RLM_BROWSER_LOG_DIR || join(workDir, 'logs'));
await mkdir(logDir, { recursive: true, mode: 0o700 });

const moduleName = env.DSH_RLM_PLAYWRIGHT_MODULE || 'playwright';
const moduleSpecifier = isAbsolute(moduleName) || moduleName.startsWith('.')
  ? pathToFileURL(resolve(moduleName)).href
  : moduleName;
const { chromium } = await import(moduleSpecifier);
const launchOptions = { headless: true };
if (env.DSH_RLM_BROWSER_EXECUTABLE) {
  launchOptions.executablePath = resolve(env.DSH_RLM_BROWSER_EXECUTABLE);
}

const sanitize = value => String(value)
  .replace(/([?&]token=)[^&#\s]+/gi, '$1<redacted>')
  .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1<redacted>')
  .replace(/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1<redacted>');

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveStop => {
    let forced = false;
    const force = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
    }, 8_000);
    const finish = () => { clearTimeout(force); resolveStop(); };
    child.once('exit', finish);
    child.kill('SIGTERM');
    setTimeout(() => { if (forced && child.exitCode === null) resolveStop(); }, 2_000).unref();
  });
}

async function startServer(label, port) {
  const home = join(workDir, `${label}-home`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `${label}.log`);
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  const wheel = env.DSH_RLM_BROWSER_WHEEL ? resolve(env.DSH_RLM_BROWSER_WHEEL) : undefined;
  if (wheel) await access(wheel);
  const command = wheel ? required('DSH_RLM_BROWSER_UV', 'uv') : node;
  const args = wheel
    ? ['tool', 'run', '--from', wheel, 'dsh-rlm', '--port', String(port), '--no-open']
    : [launcher, '--port', String(port), '--no-open'];
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...env, DSH_RLM_HOME: home, DSH_RLM_PYTHON: python, DSH_RLM_APP_DIR: appDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let settled = false;
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectReady(new Error(`timed out waiting for ${label} server launch`));
    }, 60_000);
    const inspect = chunk => {
      log.write(chunk);
      output = (output + chunk.toString('utf8')).slice(-64_000);
      const match = output.match(/dsh web:\s+(https?:\/\/\S+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolveReady(match[1]);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', chunk => log.write(chunk));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectReady(new Error(`${label} server could not start: ${sanitize(error.message)}`));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectReady(new Error(`${label} server exited before launch (code=${code}, signal=${signal})`));
    });
  });
  try {
    const url = await ready;
    return {
      url,
      logPath,
      async stop() {
        await stopChild(child);
        await new Promise(resolveLog => log.end(resolveLog));
      },
    };
  } catch (error) {
    await stopChild(child);
    await new Promise(resolveLog => log.end(resolveLog));
    throw error;
  }
}

function endpoint(request) {
  try { return new URL(request.url()).pathname; }
  catch { return '<invalid-url>'; }
}

async function dismissTestingNotice(page) {
  const button = page.getByRole('button', { name: 'Continue', exact: true });
  try {
    await button.first().waitFor({ state: 'visible', timeout: 10_000 });
    await button.first().click();
  } catch (error) {
    if (await button.count()) throw error;
  }
}

const requiredOnboardingEndpoints = [
  '/api/llm/listProviders',
  '/api/llm/listConfigurableProviders',
  '/api/session/modelCatalog',
  '/api/subscriptions-auth.status',
];

async function verifyCase(browser, { label, port, destination }) {
  const server = await startServer(label, port);
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    const failures = [];
    const badResponses = [];
    page.on('request', request => {
      if (request.method() === 'POST') requests.push(endpoint(request));
    });
    page.on('requestfailed', request => {
      failures.push({ method: request.method(), path: endpoint(request), error: request.failure()?.errorText || 'failed' });
    });
    page.on('response', response => {
      if (response.status() >= 400) {
        badResponses.push({ method: response.request().method(), path: endpoint(response.request()), status: response.status() });
      }
    });
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await dismissTestingNotice(page);
    await page.getByRole('heading', { name: 'Set up dsh-rlm', exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const provider = document.querySelector('select');
      return provider && provider.options.length > 1;
    }, undefined, { timeout: 30_000 });

    const providerCount = await page.locator('select').first().locator('option').count();
    assert.ok(providerCount > 1, `${label}: provider dropdown remained empty`);
    const body = await page.locator('body').innerText();
    assert.ok(!body.includes('Could not read provider/authentication state'), `${label}: old generic setup failure remained visible`);
    assert.ok(!body.includes('Setup could not refresh.'), `${label}: setup refresh failed`);
    assert.ok(!body.includes('No providers could be listed yet.'), `${label}: provider directory was unavailable`);

    for (const path of requiredOnboardingEndpoints) {
      assert.ok(requests.includes(path), `${label}: missing required Host request ${path}`);
    }
    const requiredFailures = [...failures, ...badResponses]
      .filter(failure => requiredOnboardingEndpoints.includes(failure.path));
    assert.deepEqual(requiredFailures, [], `${label}: required onboarding endpoints failed`);

    if (destination === 'models') {
      await page.getByRole('button', { name: 'Set up an API provider', exact: true }).click();
      await page.getByText('Enter your API keys to use models from the following providers.', { exact: true })
        .waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Add provider', exact: true }).waitFor({ timeout: 30_000 });
      assert.ok(await page.getByRole('button', { name: 'Add provider', exact: true }).isVisible(),
        `${label}: Models settings did not expose provider configuration`);
    } else {
      await page.getByRole('button', { name: 'Connect a subscription', exact: true }).click();
      await page.getByText('Log a subscription provider in or out.', { exact: false })
        .waitFor({ timeout: 30_000 });
      assert.ok(await page.getByText('Codex (ChatGPT)', { exact: true }).isVisible(),
        `${label}: Subscriptions settings did not render Codex`);
      await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Log in').length >= 5,
        undefined, { timeout: 30_000 });
      assert.ok(await page.getByRole('button', { name: 'Log in', exact: true }).count() >= 5,
        `${label}: Subscriptions settings did not render login actions`);
    }

    const screenshot = join(workDir, `${label}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    return {
      destination,
      providerCount,
      screenshot,
      failedEndpoints: failures.map(({ method, path, error }) => ({ method, path, error })),
      httpErrors: badResponses,
    };
  } finally {
    await context?.close();
    await server.stop();
  }
}

let browser;
try {
  browser = await chromium.launch(launchOptions);
  const api = await verifyCase(browser, { label: 'api-provider', port: basePort, destination: 'models' });
  const subscription = await verifyCase(browser, { label: 'subscription', port: basePort + 1, destination: 'subscriptions' });
  console.log(JSON.stringify({
    ok: true,
    appDir,
    workDir,
    logDir,
    cases: [api, subscription],
  }, null, 2));
} catch (error) {
  console.error(sanitize(error?.stack || error));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
