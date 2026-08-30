import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-accounts-"));
const codexHome = path.join(root, "codex");
const stateDir = path.join(root, "state");
const accountsDir = path.join(stateDir, "chatgpt-accounts");
const policyPath = path.join(stateDir, "chatgpt-account-policy.json");
process.env.CODEX_HOME = codexHome;
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_CHATGPT_ACCOUNTS_DIR = accountsDir;
process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_POLICY = policyPath;

const {
  addChatGptAccount,
  chatGptAccountsSnapshot,
  classifyChatGptAccountResponse,
  chatGptTransportFailure,
  coolChatGptAccount,
  rememberChatGptAccount,
  reloginChatGptAccount,
  selectChatGptAccountCandidates,
  setChatGptAccountState,
  setPreferredChatGptAccount,
} = await import("../src/chatgpt-accounts.mjs");

function jwt(exp = Math.floor(Date.now() / 1000) + 86_400) {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

function auth(accountId, accessToken = jwt()) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken,
      account_id: accountId,
      refresh_token: `refresh-${accountId}`,
      id_token: `id-${accountId}`,
    },
  };
}

function writePrivateJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const backupId = "chatgpt_abcdefghijklmnop";
let isolatedProfileId;
const defaultAccount = "acct-default";
const backupAccount = "acct-backup";
writePrivateJson(path.join(codexHome, "auth.json"), auth(defaultAccount, "default-test-token"));
writePrivateJson(path.join(accountsDir, backupId, "auth.json"), auth(backupAccount, "backup-test-token"));
writePrivateJson(policyPath, {
  schemaVersion: 1,
  policy: "sticky-fallback",
  preferred: "default",
  accounts: [{
    id: backupId,
    label: "Backup subscription",
    state: "active",
    accountFingerprint: createHash("sha256").update(backupAccount).digest("hex"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }],
});

test("ChatGPT account snapshots contain metadata but no OAuth credentials", () => {
  const snapshot = chatGptAccountsSnapshot();
  assert.equal(snapshot.policy, "sticky-fallback");
  assert.equal(snapshot.preferred, "default");
  assert.deepEqual(snapshot.accounts.map((entry) => entry.id), ["default", backupId]);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /default-test-token|backup-test-token|refresh-acct|id-acct/);
  assert.equal(statSync(path.join(accountsDir, backupId, "auth.json")).mode & 0o777, 0o600);
});

test("additional subscriptions are acquired in an isolated official Codex home", () => {
  const fakeCodex = path.join(root, "fake-codex");
  const isolatedAccount = "acct-isolated-login";
  const isolatedAuth = JSON.stringify(auth(isolatedAccount, "isolated-access-token"));
  writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "set -eu",
    "test \"$1\" = login",
    "mkdir -p \"$CODEX_HOME\"",
    `printf '%s\\n' '${isolatedAuth}' > \"$CODEX_HOME/auth.json\"`,
    "chmod 600 \"$CODEX_HOME/auth.json\"",
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o700);
  const activeBefore = readFileSync(path.join(codexHome, "auth.json"), "utf8");
  process.env.CODEX_BIN = fakeCodex;
  try {
    const added = addChatGptAccount({ label: "Isolated login" });
    isolatedProfileId = added.id;
    assert.match(added.id, /^chatgpt_/);
    const profile = path.join(accountsDir, added.id);
    assert.equal(statSync(profile).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(profile, "auth.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(path.join(codexHome, "auth.json"), "utf8"), activeBefore);
    const metadata = readFileSync(policyPath, "utf8");
    assert.doesNotMatch(metadata, /isolated-access-token|acct-isolated-login/);
  } finally {
    delete process.env.CODEX_BIN;
  }
});

test("signing an existing profile into the wrong account restores its prior OAuth state", () => {
  assert.ok(isolatedProfileId);
  const authPath = path.join(accountsDir, isolatedProfileId, "auth.json");
  const before = readFileSync(authPath, "utf8");
  const fakeCodex = path.join(root, "fake-codex-wrong-relogin");
  const wrongAuth = JSON.stringify(auth("acct-wrong-login", "wrong-access-token"));
  writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "set -eu",
    `printf '%s\\n' '${wrongAuth}' > \"$CODEX_HOME/auth.json\"`,
    "chmod 600 \"$CODEX_HOME/auth.json\"",
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o700);
  process.env.CODEX_BIN = fakeCodex;
  try {
    assert.throws(() => reloginChatGptAccount(isolatedProfileId), /different ChatGPT account/i);
    assert.equal(readFileSync(authPath, "utf8"), before);
  } finally {
    delete process.env.CODEX_BIN;
  }
});

test("a duplicate official login is rejected without retaining its OAuth profile", () => {
  const fakeCodex = path.join(root, "fake-codex-duplicate");
  const duplicateAuth = JSON.stringify(auth(defaultAccount, "duplicate-access-token"));
  writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "set -eu",
    "mkdir -p \"$CODEX_HOME\"",
    `printf '%s\\n' '${duplicateAuth}' > \"$CODEX_HOME/auth.json\"`,
    "chmod 600 \"$CODEX_HOME/auth.json\"",
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o700);
  const before = new Set(readdirSync(accountsDir));
  process.env.CODEX_BIN = fakeCodex;
  try {
    assert.throws(() => addChatGptAccount({ label: "Duplicate" }), /already in the account pool/i);
    assert.deepEqual(new Set(readdirSync(accountsDir)), before);
  } finally {
    delete process.env.CODEX_BIN;
  }
});

test("preferred ChatGPT selection becomes conversation-sticky and respects cooldown", async () => {
  const caller = {
    authorization: "Bearer default-test-token",
    "chatgpt-account-id": defaultAccount,
  };
  setPreferredChatGptAccount(backupId);
  assert.equal(selectChatGptAccountCandidates(caller, "conversation-a")[0].id, backupId);
  rememberChatGptAccount("conversation-a", "default");
  assert.equal(selectChatGptAccountCandidates(caller, "conversation-a")[0].id, "default");
  coolChatGptAccount("default", Date.now() + 60_000);
  assert.equal(selectChatGptAccountCandidates(caller, "conversation-a")[0].id, backupId);
  // Cooldowns are process-wide by design; let the test's synthetic one expire
  // before later cases inspect independent conversations.
  coolChatGptAccount("default", Date.now());
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  setPreferredChatGptAccount("default");
});

test("paused ChatGPT profiles are not selected", () => {
  const caller = {
    authorization: "Bearer default-test-token",
    "chatgpt-account-id": defaultAccount,
  };
  setChatGptAccountState(backupId, "paused");
  const selected = selectChatGptAccountCandidates(caller, "conversation-b").map((entry) => entry.id);
  assert.equal(selected[0], "default");
  assert.equal(selected.includes(backupId), false);
  setChatGptAccountState(backupId, "active");
});

test("transport failures are recoverable except for client cancellation", () => {
  assert.equal(chatGptTransportFailure(new AbortController().signal, new Error("reset")).recoverable, true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(chatGptTransportFailure(controller.signal, new Error("reset")).recoverable, false);
  assert.equal(chatGptTransportFailure(undefined, { name: "AbortError" }).recoverable, false);
});

test("exhausted native edge statuses are account-recoverable transport failures", async () => {
  const failure = await classifyChatGptAccountResponse(new Response("edge failed", { status: 503 }));
  assert.equal(failure.recoverable, true);
  assert.equal(failure.reason, "transport");
  const deterministic = await classifyChatGptAccountResponse(new Response("origin failed", { status: 500 }));
  assert.equal(deterministic.recoverable, false);
});

test("a router-local caller without explicit ChatGPT sharing cannot spend pooled subscriptions", () => {
  assert.deepEqual(selectChatGptAccountCandidates({}, "uncredentialed-caller"), []);
});

test("discovery-disabled mode neither reads nor mutates ChatGPT account profiles", () => {
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  try {
    const snapshot = chatGptAccountsSnapshot();
    assert.equal(snapshot.accounts.length, 1);
    assert.equal(snapshot.accounts[0].session, "unavailable");
    assert.deepEqual(selectChatGptAccountCandidates({ authorization: "Bearer supplied" }, "idle"), []);
    assert.throws(() => setPreferredChatGptAccount("default"), /discovery is disabled/i);
  } finally {
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
  }
});

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function waitFor(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Router exited early: ${child.errors()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Router did not become ready: ${child.errors()}`);
}

test("native ChatGPT turns fall back before relay and remain on the working subscription", async (t) => {
  const childRoot = mkdtempSync(path.join(os.tmpdir(), "chatgpt-account-router-"));
  const childState = path.join(childRoot, "state");
  const childCodex = path.join(childRoot, "codex");
  const childAccounts = path.join(childState, "chatgpt-accounts");
  const childPolicy = path.join(childState, "chatgpt-account-policy.json");
  writePrivateJson(path.join(childCodex, "auth.json"), auth(defaultAccount, "unused-on-disk-default"));
  writePrivateJson(path.join(childAccounts, backupId, "auth.json"), auth(backupAccount, "backup-router-token"));
  writePrivateJson(childPolicy, {
    schemaVersion: 1,
    policy: "sticky-fallback",
    preferred: "default",
    accounts: [{
      id: backupId,
      label: "Backup subscription",
      state: "active",
      accountFingerprint: createHash("sha256").update(backupAccount).digest("hex"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  });

  const seen = [];
  let failureMode = "rate";
  const native = await mockServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    seen.push({ authorization: request.headers.authorization, account: request.headers["chatgpt-account-id"] });
    if (request.headers.authorization === "Bearer caller-default-token" && failureMode === "rate") {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
      response.end(JSON.stringify({ error: { message: "subscription rate limit" } }));
      return;
    }
    if (request.headers.authorization === "Bearer caller-default-token" && failureMode === "auth") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid session" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "resp-ok", output: [] }));
  });
  t.after(() => new Promise((resolve) => native.server.close(resolve)));

  const routerPort = await openPort();
  const callerKey = "chatgpt-account-router-caller-key-long-enough";
  const internalKey = "chatgpt-account-router-internal-key-long-enough";
  const child = spawn(process.execPath, [path.resolve("src/router.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CODEX_HOME: childCodex,
      MODEL_ROUTER_STATE_DIR: childState,
      MODEL_ROUTER_CHATGPT_ACCOUNTS_DIR: childAccounts,
      MODEL_ROUTER_CHATGPT_ACCOUNT_POLICY: childPolicy,
      CODEX_ROUTER_PORT: String(routerPort),
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${native.port}/v1`,
      CODEX_ROUTER_CALLER_KEY: callerKey,
      CODEX_ROUTER_INTERNAL_KEY: internalKey,
      KIMI_INTERNAL_KEY: internalKey,
      CODEX_ROUTER_QUIET: "1",
      CODEX_ROUTER_NATIVE_RETRIES: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.errors = () => errors;
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });

  const base = callerBaseUrl(routerPort, callerKey);
  await waitFor(`${base}/models`, child);
  failureMode = "auth";
  const authFailure = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer caller-default-token",
      "ChatGPT-Account-Id": defaultAccount,
      "Thread-Id": "authentication-must-not-fallback",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
  });
  assert.equal(authFailure.status, 401);
  assert.equal(seen.length, 1, "401 must not spend a second subscription");
  assert.deepEqual(seen.at(-1), { authorization: "Bearer caller-default-token", account: defaultAccount });

  failureMode = "rate";
  const call = () => fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer caller-default-token",
      "ChatGPT-Account-Id": defaultAccount,
      "Thread-Id": "sticky-native-thread",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
  });

  const first = await call();
  assert.equal(first.status, 200, `${await first.text()}\n${errors}`);
  assert.deepEqual(seen.slice(-2), [
    { authorization: "Bearer caller-default-token", account: defaultAccount },
    { authorization: "Bearer backup-router-token", account: backupAccount },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = await call();
  assert.equal(second.status, 200, `${await second.text()}\n${errors}`);
  assert.deepEqual(seen.at(-1), { authorization: "Bearer backup-router-token", account: backupAccount });
});
