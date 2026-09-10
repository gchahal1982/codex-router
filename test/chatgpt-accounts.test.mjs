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
  chatGptAccountsUsage,
  classifyChatGptAccountResponse,
  chatGptTransportFailure,
  coolChatGptAccount,
  rememberChatGptAccount,
  reloginChatGptAccount,
  renameChatGptAccount,
  chatGptAccountIsDrained,
  orderChatGptAccountCandidates,
  redeemChatGptAccountResetCredit,
  selectChatGptAccountCandidates,
  setChatGptAccountOrder,
  setChatGptAccountPurpose,
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

test("ChatGPT accounts can be reordered for display and fallback", () => {
  const ids = chatGptAccountsSnapshot().accounts.map((entry) => entry.id);
  assert.ok(ids.includes("default"));
  assert.ok(ids.includes(backupId));
  const reordered = [ids[ids.length - 1], ...ids.slice(0, -1)];
  const snapshot = setChatGptAccountOrder(reordered);
  assert.deepEqual(snapshot.accounts.map((entry) => entry.id), reordered);
  const saved = JSON.parse(readFileSync(policyPath, "utf8"));
  assert.deepEqual(saved.order, reordered);
  setChatGptAccountOrder(ids);
});

test("ChatGPT account labels can be renamed including the default login", () => {
  const renamed = renameChatGptAccount("default", "Work Pro");
  assert.equal(renamed.accounts.find((entry) => entry.id === "default")?.label, "Work Pro");
  const backup = renameChatGptAccount(backupId, "Backup Pro");
  assert.equal(backup.accounts.find((entry) => entry.id === backupId)?.label, "Backup Pro");
  const saved = JSON.parse(readFileSync(policyPath, "utf8"));
  assert.equal(saved.defaultLabel, "Work Pro");
  assert.equal(saved.accounts.find((entry) => entry.id === backupId)?.label, "Backup Pro");
  assert.throws(() => renameChatGptAccount("default", "  "), /must not be empty/i);
  assert.throws(() => renameChatGptAccount("chatgpt_notfoundaccount1", "Nope"), /not found/i);
  renameChatGptAccount("default", "Current Codex login");
  renameChatGptAccount(backupId, "Backup subscription");
});

test("new ChatGPT conversations skip drained leftovers until a conversation is sticky", () => {
  assert.equal(chatGptAccountIsDrained({ weekly: { remainingPercent: 0 } }), true);
  assert.equal(chatGptAccountIsDrained({ fiveHour: { remainingPercent: 0 }, weekly: { remainingPercent: 40 } }), true);
  assert.equal(chatGptAccountIsDrained({ weekly: { remainingPercent: 12 } }), false);
  assert.equal(chatGptAccountIsDrained({}), false);
  const leftoverById = new Map([
    ["default", { weekly: { remainingPercent: 0 } }],
    [backupId, { weekly: { remainingPercent: 40 }, fiveHour: { remainingPercent: 80 } }],
  ]);
  const ordered = orderChatGptAccountCandidates(
    [{ id: "default" }, { id: backupId }],
    {
      preferred: "default",
      leftoverById,
      order: ["default", backupId],
    },
  );
  assert.deepEqual(ordered.map((entry) => entry.id), [backupId, "default"]);
  const sticky = orderChatGptAccountCandidates(
    [{ id: "default" }, { id: backupId }],
    {
      sticky: "default",
      preferred: "default",
      leftoverById,
      order: ["default", backupId],
    },
  );
  assert.equal(sticky[0].id, "default");
});

test("ChatGPT account purposes persist and pin leftover-tied fallback", () => {
  const snapshot = setChatGptAccountPurpose(backupId, "auraone");
  assert.equal(snapshot.accounts.find((entry) => entry.id === backupId)?.purpose, "auraone");
  const saved = JSON.parse(readFileSync(policyPath, "utf8"));
  assert.equal(saved.accounts.find((entry) => entry.id === backupId)?.purpose, "auraone");
  setChatGptAccountPurpose("default", "personal");
  const leftoverById = new Map([
    ["default", { weekly: { remainingPercent: 40 } }],
    [backupId, { weekly: { remainingPercent: 40 } }],
  ]);
  const ordered = orderChatGptAccountCandidates(
    [{ id: backupId }, { id: "default" }],
    {
      leftoverById,
      purposeById: { default: "personal", [backupId]: "auraone" },
      pinOrder: ["personal", "auraone", "veerone", "foundation"],
      order: [backupId, "default"],
    },
  );
  assert.equal(ordered[0].id, "default");
  setChatGptAccountPurpose(backupId, "reserve");
});

test("remembered ChatGPT affinities survive a process-local file write", () => {
  rememberChatGptAccount("conversation-persist", backupId);
  const affinityPath = path.join(stateDir, "chatgpt-account-affinities.json");
  const saved = JSON.parse(readFileSync(affinityPath, "utf8"));
  assert.equal(saved.recent.at(-1).conversationId, "conversation-persist");
  assert.equal(saved.recent.at(-1).accountId, backupId);
  assert.doesNotMatch(JSON.stringify(saved), /token|refresh|Bearer/i);
});

test("a reserve ChatGPT account auto-resumes after a leftover reset", async () => {
  setChatGptAccountPurpose(backupId, "reserve");
  setChatGptAccountState(backupId, "paused");
  writePrivateJson(path.join(stateDir, "chatgpt-account-usage.json"), {
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    accounts: [
      { id: "default", weekly: { remainingPercent: 8 } },
      { id: backupId, weekly: { remainingPercent: 0 } },
    ],
  });
  const usage = await chatGptAccountsUsage({
    readUsage: async ({ codexHome: home }) => ({
      fetchedAt: "2026-09-06T00:00:00.000Z",
      planType: "pro",
      primary: {
        usedPercent: home === codexHome ? 92 : 20,
        remainingPercent: home === codexHome ? 8 : 80,
        windowDurationMins: 10_080,
        resetsAt: 2,
      },
      secondary: { usedPercent: 10, remainingPercent: 90, windowDurationMins: 300, resetsAt: 1 },
    }),
  });
  assert.equal(usage.accounts.find((entry) => entry.id === backupId)?.state, "active");
  assert.equal(JSON.parse(readFileSync(policyPath, "utf8")).accounts.find((entry) => entry.id === backupId)?.state, "active");
  assert.notEqual(usage.routing?.using, "default");
  assert.equal(usage.skippedPreferred, true);
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

test("ChatGPT account usage probes each isolated Codex home", async () => {
  const homes = [];
  const usage = await chatGptAccountsUsage({
    readUsage: async ({ codexHome }) => {
      homes.push(codexHome);
      return {
        fetchedAt: "2026-09-06T00:00:00.000Z",
        planType: "pro",
        primary: { usedPercent: 90, remainingPercent: 10, windowDurationMins: 10_080, resetsAt: 2 },
        secondary: { usedPercent: 20, remainingPercent: 80, windowDurationMins: 300, resetsAt: 1 },
      };
    },
  });
  assert.ok(homes.includes(codexHome));
  assert.ok(homes.includes(path.join(accountsDir, backupId)));
  const backup = usage.accounts.find((entry) => entry.id === backupId);
  assert.equal(backup.weekly.remainingPercent, 10);
  assert.equal(backup.fiveHour.remainingPercent, 80);
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

test("a banked reset is redeemed against the account's own Codex home", async () => {
  setChatGptAccountState(backupId, "active");
  const seen = [];
  const result = await redeemChatGptAccountResetCredit(backupId, {
    refresh: false,
    consume: async ({ codexHome: home }) => {
      seen.push(home);
      return { outcome: "reset", idempotencyKey: "key-1" };
    },
  });
  assert.deepEqual(seen, [path.join(accountsDir, backupId)]);
  assert.equal(result.redeemed, true);
  assert.equal(result.outcome, "reset");
  assert.equal(result.accountId, backupId);
});

test("redeeming reports the server outcome instead of assuming the limit cleared", async () => {
  for (const outcome of ["noCredit", "nothingToReset", "alreadyRedeemed"]) {
    const result = await redeemChatGptAccountResetCredit("default", {
      refresh: false,
      consume: async () => ({ outcome }),
    });
    assert.equal(result.redeemed, false);
    assert.equal(result.outcome, outcome);
  }
});

test("redeeming a banked reset rejects unknown accounts", async () => {
  await assert.rejects(
    () => redeemChatGptAccountResetCredit("chatgpt_missingaccountid00000000", {
      refresh: false,
      consume: async () => ({ outcome: "reset" }),
    }),
    /was not found/,
  );
  await assert.rejects(
    () => redeemChatGptAccountResetCredit("not-an-account", {
      refresh: false,
      consume: async () => ({ outcome: "reset" }),
    }),
    /Invalid ChatGPT account id/,
  );
});

test("the leftover cache carries redeemable banked resets for the panel", async () => {
  const usage = await chatGptAccountsUsage({
    readUsage: async ({ codexHome: home }) => ({
      fetchedAt: "2026-09-06T00:00:00.000Z",
      planType: "pro",
      primary: { usedPercent: 100, remainingPercent: 0, windowDurationMins: 10_080, resetsAt: 2 },
      secondary: { usedPercent: 100, remainingPercent: 0, windowDurationMins: 300, resetsAt: 1 },
      resetCredits:
        home === codexHome
          ? { availableCount: 2, credits: [{ id: "credit_a", status: "available", limitId: "codex" }] }
          : { availableCount: 0, credits: [] },
    }),
  });
  assert.equal(usage.accounts.find((entry) => entry.id === "default")?.resetCredits?.availableCount, 2);
  const cached = JSON.parse(readFileSync(path.join(stateDir, "chatgpt-account-usage.json"), "utf8"));
  assert.deepEqual(
    cached.accounts.find((entry) => entry.id === "default")?.resetCredits,
    { availableCount: 2 },
  );
  assert.equal(cached.accounts.find((entry) => entry.id === backupId)?.resetCredits, null);
  // Per-read credit ids are not durable state; only the count is cached.
  assert.equal(JSON.stringify(cached).includes("credit_a"), false);
});
