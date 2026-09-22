import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");
test("client bundle is a lazy CJS module-loader registration", async () => {
  const source = await read("lib/client.js");
  assert.ok(source.includes("window.__ModuleLoader__.load("));
  assert.ok(source.includes('id: "@dsh-rlm/jev-settings"'));
  assert.ok(source.includes("exports.apply = apply"));
  assert.ok(source.includes("exports.inject = inject"));
});
test("Jev UI uses public settings, credentials, and fixed RPC contracts", async () => {
  const source = await read("lib/client.js");
  for (const token of ["settings.section", "settingsScope.bind", "remote.credentials.describe", "remote.credentials.set", "remote.credentials.unset", "jev/status", "jev/testConnection", "Jev Judge", "apiKeyEnv", "baseURL", "AbortController"]) assert.ok(source.includes(token), token);
  assert.ok(source.includes("args: {}"));
  assert.ok(source.includes("Connection test failed. Check the credential"));
  assert.ok(!source.includes("process.env"));
});
test("host entry is no-op and package metadata declares browser externals", async () => {
  const host = await read("lib/index.js");
  assert.ok(host.includes("export function apply"));
  const packageJson = JSON.parse(await read("package.json"));
  assert.deepEqual(packageJson.dsh.client.external, ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-store"]);
});
