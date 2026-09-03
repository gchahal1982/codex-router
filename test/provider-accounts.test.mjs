import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openPort } from "./port-pool.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "provider-accounts-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.MODEL_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = path.join(root, "state", "provider-credentials.json");
process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_CREDENTIALS_DIR = path.join(root, "state", "provider-account-credentials");
process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_POLICY = path.join(root, "state", "provider-account-policy.json");

const {
  addProviderAccount,
  classifyProviderAccountResponse,
  coolProviderAccount,
  providerAccountsSnapshot,
  rememberProviderAccount,
  removeProviderAccount,
  selectProviderAccountCandidates,
  setPreferredProviderAccount,
  setProviderAccountState,
} = await import("../src/provider-accounts.mjs");
const { apiProvider, writeProviderCredential } = await import("../src/provider-credentials.mjs");

const provider = apiProvider("deepseek");
writeProviderCredential(provider, "default-test-key");

test("additional accounts are protected, metadata-only, and default to sticky fallback", () => {
  const added = addProviderAccount(provider, {
    value: "second-test-key",
    label: "Backup plan",
    plan: "secondary",
  });
  const snapshot = providerAccountsSnapshot(provider);
  assert.equal(snapshot.policy, "sticky-fallback");
  assert.equal(snapshot.preferred, "default");
  assert.equal(snapshot.accounts.length, 2);
  assert.equal(snapshot.accounts[1].label, "Backup plan");

  const secretPath = path.join(process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_CREDENTIALS_DIR, `${added.id}.key`);
  assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(secretPath)).mode & 0o777, 0o700);
  const metadata = readFileSync(process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE, "utf8");
  assert.equal(metadata.includes("second-test-key"), false);
  assert.equal(readFileSync(secretPath, "utf8").trim(), "second-test-key");
});

test("preferred selection sticks per conversation and changes only after cooldown", () => {
  const backup = providerAccountsSnapshot(provider).accounts[1];
  setPreferredProviderAccount(provider, backup.id);
  assert.equal(selectProviderAccountCandidates(provider, "thread-a")[0].id, backup.id);

  rememberProviderAccount(provider, "thread-a", "default");
  assert.equal(selectProviderAccountCandidates(provider, "thread-a")[0].id, "default");

  coolProviderAccount(provider, "default", Date.now() + 60_000);
  assert.equal(selectProviderAccountCandidates(provider, "thread-a")[0].id, backup.id);
});

test("paused and removed accounts cannot be selected and removal deletes the secret", () => {
  const backup = providerAccountsSnapshot(provider).accounts[1];
  setPreferredProviderAccount(provider, "default");
  setProviderAccountState(provider, backup.id, "paused");
  assert.deepEqual(selectProviderAccountCandidates(provider, "thread-b").map((entry) => entry.id), ["default"]);
  setProviderAccountState(provider, backup.id, "active");
  const secretPath = path.join(process.env.MODEL_ROUTER_PROVIDER_ACCOUNT_CREDENTIALS_DIR, `${backup.id}.key`);
  assert.equal(removeProviderAccount(provider, backup.id), true);
  assert.equal(existsSync(secretPath), false);
});

test("only quota and rate-limit responses are account-recoverable", async () => {
  assert.equal((await classifyProviderAccountResponse(new Response("busy", { status: 429 }))).recoverable, true);
  assert.equal((await classifyProviderAccountResponse(new Response("quota exhausted", { status: 403 }))).recoverable, true);
  assert.equal((await classifyProviderAccountResponse(new Response("bad key", { status: 401 }))).recoverable, false);
  assert.equal((await classifyProviderAccountResponse(new Response("forbidden", { status: 403 }))).recoverable, false);
  assert.equal((await classifyProviderAccountResponse(new Response("bad request", { status: 400 }))).recoverable, false);
});

test("the API forwarder falls back before relay and keeps the conversation on the working account", async (t) => {
  addProviderAccount(provider, { value: "sticky-backup-key", label: "Sticky backup" });
  setPreferredProviderAccount(provider, "default");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    requests.push(request.headers.authorization);
    if (request.headers.authorization === "Bearer default-test-key") {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamAddress = upstream.address();
  assert.ok(typeof upstreamAddress === "object" && upstreamAddress);

  const port = await openPort();
  const internalKey = "provider-account-forwarder-test-internal-key";
  const child = spawn(process.execPath, [path.resolve("src/api-forwarder.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CODEX_ROUTER_INTERNAL_KEY: internalKey,
      CODEX_ROUTER_API_PORT: String(port),
      DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      CODEX_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  });

  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${internalKey}` },
      });
      if (health.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(child.exitCode, null, errors);
  assert.equal(ready, true, `Forwarder did not become ready.\n${errors}`);

  const call = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalKey}`,
      "Content-Type": "application/json",
      "X-Codex-Router-Conversation": "conversation-one",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  const first = await call();
  assert.equal(first.status, 200, `${await first.text()}\n${errors}`);
  assert.deepEqual(requests, ["Bearer default-test-key", "Bearer sticky-backup-key"]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = await call();
  assert.equal(second.status, 200, `${await second.text()}\n${errors}`);
  assert.deepEqual(requests, [
    "Bearer default-test-key",
    "Bearer sticky-backup-key",
    "Bearer sticky-backup-key",
  ]);
});

test("the API forwarder gives Kiro Prism a stable opaque harness session", async (t) => {
  const prism = apiProvider("kiro-prism");
  writeProviderCredential(prism, "prism-test-key");
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    requests.push(request.headers);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamAddress = upstream.address();
  assert.ok(typeof upstreamAddress === "object" && upstreamAddress);

  const port = await openPort();
  const internalKey = "prism-affinity-test-internal-key";
  const child = spawn(process.execPath, [path.resolve("src/api-forwarder.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CODEX_ROUTER_INTERNAL_KEY: internalKey,
      CODEX_ROUTER_API_PORT: String(port),
      KIRO_PRISM_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      CODEX_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  });

  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${internalKey}` },
      });
      if (health.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(child.exitCode, null, errors);
  assert.equal(ready, true, `Forwarder did not become ready.\n${errors}`);

  const call = () => fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalKey}`,
      "Content-Type": "application/json",
      "X-Codex-Router-Conversation": "opaque-thread-hash",
    },
    body: JSON.stringify({
      model: "kiro-prism-gpt-5-6-sol",
      input: "hello",
    }),
  });

  const first = await call();
  assert.equal(first.status, 200, `${await first.text()}\nrequests=${requests.length}\n${errors}`);
  const second = await call();
  assert.equal(second.status, 200, `${await second.text()}\n${errors}`);
  assert.equal(requests.length, 2);
  for (const headers of requests) {
    assert.equal(headers["x-prism-session"], "opaque-thread-hash");
    assert.equal(headers["x-prism-client"], "codex-router");
    assert.equal(headers["x-prism-job-type"], "coding-agent");
    assert.equal(headers["x-codex-router-conversation"], undefined);
  }
});
