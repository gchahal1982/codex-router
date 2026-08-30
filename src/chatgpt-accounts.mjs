import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { findCodexBinary } from "./codex-binary.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import { classifyProviderAccountResponse } from "./provider-accounts.mjs";
import { isRetryableStatus } from "./upstream-retry.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import {
  CHATGPT_ACCOUNTS_DIR,
  CHATGPT_ACCOUNT_POLICY_PATH,
  CODEX_HOME,
  STATE_DIR,
} from "./paths.mjs";

export const DEFAULT_CHATGPT_ACCOUNT_ID = "default";
export const CHATGPT_ACCOUNT_POLICY = "sticky-fallback";

const ACCOUNT_ID = /^chatgpt_[A-Za-z0-9_-]{16,64}$/;
const MAX_LABEL = 160;
const MAX_ACCOUNTS = 20;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const AFFINITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AFFINITIES = 5_000;
const TRANSPORT_COOLDOWN_MS = 30_000;
const EXPIRY_SKEW_MS = 120_000;

const affinities = new Map();
const cooldowns = new Map();

function assertDiscoveryEnabled() {
  if (discoveryDisabled()) {
    throw new Error("ChatGPT account management is unavailable while credential discovery is disabled.");
  }
}

function cleanLabel(value) {
  const label = String(value || "").trim();
  if (!label) throw new Error("ChatGPT account label must not be empty.");
  if (label.length > MAX_LABEL) throw new Error("ChatGPT account label is too long.");
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new Error("ChatGPT account label contains control characters.");
  return label;
}

function managedPath(candidate) {
  const state = path.resolve(STATE_DIR);
  const target = path.resolve(candidate);
  const relative = path.relative(state, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) throw new Error("ChatGPT account state must stay inside the router state directory.");
  let current = state;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("ChatGPT account state cannot traverse a symbolic link.");
  }
  return target;
}

function accountHome(accountId) {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("Invalid ChatGPT account id.");
  return managedPath(path.join(CHATGPT_ACCOUNTS_DIR, accountId));
}

function assertRegularFile(filePath) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("ChatGPT account file must be a regular file.");
}

function atomicPrivateText(filePath, contents) {
  filePath = managedPath(filePath);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    protectPrivateFile(temporary);
    renameSync(temporary, filePath);
    protectPrivateFile(filePath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch (cleanup) { error.cleanupError = cleanup; }
    throw error;
  }
}

function atomicPrivateJson(filePath, value) {
  atomicPrivateText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function emptyPolicy() {
  return { schemaVersion: 1, policy: CHATGPT_ACCOUNT_POLICY, preferred: DEFAULT_CHATGPT_ACCOUNT_ID, accounts: [] };
}

function readPolicy({ strict = false } = {}) {
  if (!existsSync(CHATGPT_ACCOUNT_POLICY_PATH)) return emptyPolicy();
  try {
    assertRegularFile(CHATGPT_ACCOUNT_POLICY_PATH);
    const parsed = JSON.parse(readFileSync(CHATGPT_ACCOUNT_POLICY_PATH, "utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.policy !== CHATGPT_ACCOUNT_POLICY ||
      !Array.isArray(parsed.accounts) ||
      parsed.accounts.length > MAX_ACCOUNTS ||
      !(parsed.preferred === DEFAULT_CHATGPT_ACCOUNT_ID || ACCOUNT_ID.test(parsed.preferred))
    ) throw new Error("invalid policy");
    const ids = new Set();
    const accounts = parsed.accounts.map((entry) => {
      if (
        !ACCOUNT_ID.test(entry?.id) || ids.has(entry.id) ||
        typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > MAX_LABEL ||
        /[\u0000-\u001f\u007f]/.test(entry.label) ||
        !["active", "paused"].includes(entry.state) ||
        typeof entry.accountFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.accountFingerprint)
      ) throw new Error("invalid account metadata");
      ids.add(entry.id);
      return {
        id: entry.id,
        label: entry.label.trim(),
        state: entry.state,
        accountFingerprint: entry.accountFingerprint,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : undefined,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
      };
    });
    if (parsed.preferred !== DEFAULT_CHATGPT_ACCOUNT_ID && !ids.has(parsed.preferred)) {
      throw new Error("preferred account is missing");
    }
    return { schemaVersion: 1, policy: CHATGPT_ACCOUNT_POLICY, preferred: parsed.preferred, accounts };
  } catch (error) {
    if (strict) throw new Error("ChatGPT account policy is malformed or unsafe.", { cause: error });
    return emptyPolicy();
  }
}

function writePolicy(policy) {
  atomicPrivateJson(CHATGPT_ACCOUNT_POLICY_PATH, policy);
}

function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function readSession(authPath) {
  if (!existsSync(authPath)) return undefined;
  try {
    assertRegularFile(authPath);
    if (statSync(authPath).size > MAX_AUTH_FILE_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    if (parsed?.auth_mode !== "chatgpt") return undefined;
    const accessToken = typeof parsed?.tokens?.access_token === "string" ? parsed.tokens.access_token : "";
    const accountId = typeof parsed?.tokens?.account_id === "string" ? parsed.tokens.account_id : "";
    if (!accessToken || !accountId) return undefined;
    const expiresAtMs = tokenExpiryMs(accessToken);
    return {
      accessToken,
      accountId,
      accountFingerprint: createHash("sha256").update(accountId).digest("hex"),
      expiresAtMs,
      expired: expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= Date.now(),
    };
  } catch {
    return undefined;
  }
}

function profileSession(accountId) {
  if (discoveryDisabled()) return undefined;
  return readSession(path.join(accountHome(accountId), "auth.json"));
}

function defaultSession() {
  if (discoveryDisabled()) return undefined;
  return readSession(path.join(CODEX_HOME, "auth.json"));
}

export function chatGptAccountAuthPaths({ includeDefault = true } = {}) {
  if (discoveryDisabled()) return [];
  const profiles = [];
  try {
    if (existsSync(CHATGPT_ACCOUNTS_DIR)) {
      const root = lstatSync(CHATGPT_ACCOUNTS_DIR);
      if (!root.isSymbolicLink() && root.isDirectory()) {
        for (const entry of readdirSync(CHATGPT_ACCOUNTS_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory() || !ACCOUNT_ID.test(entry.name)) continue;
          const home = accountHome(entry.name);
          const authPath = path.join(home, "auth.json");
          if (existsSync(authPath)) profiles.push(authPath);
        }
      }
    }
  } catch {
    // Redaction remains best effort; unsafe paths are never followed.
  }
  return [
    ...(includeDefault ? [path.join(CODEX_HOME, "auth.json")] : []),
    ...profiles,
  ];
}

function publicAccount(entry, preferred) {
  const session = profileSession(entry.id);
  return {
    id: entry.id,
    label: entry.label,
    plan: null,
    state: entry.state,
    preferred: preferred === entry.id,
    source: "isolated official Codex login",
    session: session ? (session.expired ? "expired" : "usable") : "unavailable",
    ...(session?.expiresAtMs !== undefined
      ? { expiresInHours: Math.round(((session.expiresAtMs - Date.now()) / 36e5) * 10) / 10 }
      : {}),
  };
}

export function chatGptAccountsSnapshot() {
  if (discoveryDisabled()) {
    return {
      providerId: "openai",
      policy: CHATGPT_ACCOUNT_POLICY,
      preferred: DEFAULT_CHATGPT_ACCOUNT_ID,
      accounts: [{
        id: DEFAULT_CHATGPT_ACCOUNT_ID,
        label: "Current Codex login",
        plan: null,
        state: "missing",
        preferred: true,
        source: null,
        session: "unavailable",
      }],
    };
  }
  const policy = readPolicy();
  const current = defaultSession();
  return {
    providerId: "openai",
    policy: CHATGPT_ACCOUNT_POLICY,
    preferred: policy.preferred,
    accounts: [
      {
        id: DEFAULT_CHATGPT_ACCOUNT_ID,
        label: "Current Codex login",
        plan: null,
        state: current && !current.expired ? "active" : "missing",
        preferred: policy.preferred === DEFAULT_CHATGPT_ACCOUNT_ID,
        source: current ? "Codex-owned active login" : null,
        session: current ? (current.expired ? "expired" : "usable") : "unavailable",
        ...(current?.expiresAtMs !== undefined
          ? { expiresInHours: Math.round(((current.expiresAtMs - Date.now()) / 36e5) * 10) / 10 }
          : {}),
      },
      ...policy.accounts.map((entry) => publicAccount(entry, policy.preferred)),
    ],
  };
}

export function chatGptAccountsHealth() {
  if (discoveryDisabled()) {
    return { configured: false, safe: true, total: 0, active: 0, usable: 0 };
  }
  if (!existsSync(CHATGPT_ACCOUNT_POLICY_PATH)) {
    return { configured: false, safe: true, total: 1, active: defaultSession() ? 1 : 0, usable: defaultSession() ? 1 : 0 };
  }
  try {
    const policy = readPolicy({ strict: true });
    const problems = [];
    if (process.platform !== "win32" && (statSync(CHATGPT_ACCOUNT_POLICY_PATH).mode & 0o077)) {
      problems.push("policy permissions are broader than 0600");
    }
    let active = defaultSession() ? 1 : 0;
    let usable = defaultSession() && !defaultSession().expired ? 1 : 0;
    for (const entry of policy.accounts) {
      const home = accountHome(entry.id);
      const authPath = path.join(home, "auth.json");
      if (process.platform !== "win32") {
        if (!existsSync(home) || (statSync(home).mode & 0o077)) problems.push("an account directory is broader than 0700");
        if (existsSync(authPath) && (statSync(authPath).mode & 0o077)) problems.push("an account credential is broader than 0600");
      }
      if (entry.state === "active") {
        active += 1;
        const session = profileSession(entry.id);
        if (session && !session.expired) usable += 1;
      }
    }
    return {
      configured: policy.accounts.length > 0,
      safe: problems.length === 0,
      total: policy.accounts.length + 1,
      active,
      usable,
      problems: [...new Set(problems)],
    };
  } catch (error) {
    return {
      configured: true,
      safe: false,
      total: 0,
      active: 0,
      usable: 0,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function prepareLoginHome(accountId) {
  const home = accountHome(accountId);
  if (existsSync(home)) throw new Error("ChatGPT account login home already exists.");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const configPath = path.join(home, "config.toml");
  writeFileSync(configPath, 'cli_auth_credentials_store = "file"\n', { encoding: "utf8", mode: 0o600 });
  protectPrivateFile(configPath);
  return home;
}

function runOfficialCodexLogin(home) {
  const binary = findCodexBinary();
  if (!binary) throw new Error("The official Codex binary was not found.");
  const command = spawnableCommand(binary, ["login"]);
  const result = spawnSync(command.command, command.args, {
    ...command.options,
    env: { ...process.env, CODEX_HOME: home },
    // The official CLI opens the system browser for OAuth. Keep its terminal
    // chatter away from the control command's single JSON stdout contract;
    // no credential ever travels over these pipes.
    stdio: "ignore",
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Official Codex login was cancelled or failed.");
}

export function addChatGptAccount({ label, preferred = false } = {}) {
  assertDiscoveryEnabled();
  label = cleanLabel(label);
  if (readPolicy({ strict: true }).accounts.length >= MAX_ACCOUNTS) {
    throw new Error(`At most ${MAX_ACCOUNTS} additional ChatGPT accounts are supported.`);
  }
  const accountId = `chatgpt_${randomBytes(18).toString("base64url")}`;
  const home = prepareLoginHome(accountId);
  let completed = false;
  try {
    runOfficialCodexLogin(home);
    const session = profileSession(accountId);
    if (!session || session.expired) throw new Error("The new ChatGPT login did not produce a usable Codex session.");
    protectPrivateFile(path.join(home, "auth.json"));
    const now = new Date().toISOString();
    const entry = {
      id: accountId,
      label,
      state: "active",
      accountFingerprint: session.accountFingerprint,
      createdAt: now,
      updatedAt: now,
    };
    const selectedPreferred = withAtomicStateLock(CHATGPT_ACCOUNT_POLICY_PATH, () => {
      const currentFingerprint = defaultSession()?.accountFingerprint;
      const policy = readPolicy({ strict: true });
      if (policy.accounts.length >= MAX_ACCOUNTS) {
        throw new Error(`At most ${MAX_ACCOUNTS} additional ChatGPT accounts are supported.`);
      }
      if (
        session.accountFingerprint === currentFingerprint ||
        policy.accounts.some((candidate) => candidate.accountFingerprint === session.accountFingerprint)
      ) throw new Error("That ChatGPT subscription is already in the account pool.");
      policy.accounts.push(entry);
      if (preferred) policy.preferred = accountId;
      writePolicy(policy);
      return policy.preferred;
    });
    completed = true;
    return publicAccount(entry, selectedPreferred);
  } finally {
    if (!completed) rmSync(home, { recursive: true, force: true });
  }
}

export function reloginChatGptAccount(accountId) {
  assertDiscoveryEnabled();
  if (!ACCOUNT_ID.test(accountId)) throw new Error("Only additional ChatGPT accounts can sign in here.");
  const policy = readPolicy({ strict: true });
  const entry = policy.accounts.find((candidate) => candidate.id === accountId);
  if (!entry) throw new Error("ChatGPT account was not found.");
  const home = accountHome(accountId);
  const authPath = path.join(home, "auth.json");
  let prior;
  if (existsSync(authPath)) {
    assertRegularFile(authPath);
    if (statSync(authPath).size > MAX_AUTH_FILE_BYTES) throw new Error("ChatGPT account file is too large.");
    prior = readFileSync(authPath, "utf8");
  }
  try {
    runOfficialCodexLogin(home);
    const session = profileSession(accountId);
    if (!session || session.expired) throw new Error("The refreshed ChatGPT login is not usable.");
    if (session.accountFingerprint !== entry.accountFingerprint) {
      throw new Error("The browser signed in to a different ChatGPT account; the original profile was restored.");
    }
    protectPrivateFile(authPath);
    return publicAccount(entry, policy.preferred);
  } catch (error) {
    if (prior !== undefined) {
      atomicPrivateText(authPath, prior);
    } else {
      rmSync(authPath, { force: true });
    }
    throw error;
  }
}

export function setPreferredChatGptAccount(accountId) {
  assertDiscoveryEnabled();
  return withAtomicStateLock(CHATGPT_ACCOUNT_POLICY_PATH, () => {
    const policy = readPolicy({ strict: true });
    if (
      accountId !== DEFAULT_CHATGPT_ACCOUNT_ID &&
      !policy.accounts.some((entry) => entry.id === accountId && entry.state === "active")
    ) throw new Error("Preferred ChatGPT account must exist and be active.");
    policy.preferred = accountId;
    writePolicy(policy);
    return chatGptAccountsSnapshot();
  });
}

export function setChatGptAccountState(accountId, state) {
  assertDiscoveryEnabled();
  if (!ACCOUNT_ID.test(accountId) || !["active", "paused"].includes(state)) {
    throw new Error("Invalid ChatGPT account state change.");
  }
  return withAtomicStateLock(CHATGPT_ACCOUNT_POLICY_PATH, () => {
    const policy = readPolicy({ strict: true });
    const entry = policy.accounts.find((candidate) => candidate.id === accountId);
    if (!entry) throw new Error("ChatGPT account was not found.");
    entry.state = state;
    entry.updatedAt = new Date().toISOString();
    if (state !== "active" && policy.preferred === accountId) policy.preferred = DEFAULT_CHATGPT_ACCOUNT_ID;
    writePolicy(policy);
    if (state !== "active") forgetChatGptAccountAffinities(accountId);
    return chatGptAccountsSnapshot();
  });
}

export function removeChatGptAccount(accountId) {
  assertDiscoveryEnabled();
  if (!ACCOUNT_ID.test(accountId)) throw new Error("Only additional ChatGPT accounts can be removed.");
  return withAtomicStateLock(CHATGPT_ACCOUNT_POLICY_PATH, () => {
    const policy = readPolicy({ strict: true });
    const before = policy.accounts.length;
    policy.accounts = policy.accounts.filter((entry) => entry.id !== accountId);
    if (policy.accounts.length === before) return false;
    if (policy.preferred === accountId) policy.preferred = DEFAULT_CHATGPT_ACCOUNT_ID;
    writePolicy(policy);
    const home = accountHome(accountId);
    if (existsSync(home)) {
      const stat = lstatSync(home);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("ChatGPT account home is unsafe to remove.");
      rmSync(home, { recursive: true, force: true });
    }
    forgetChatGptAccountAffinities(accountId);
    return true;
  });
}

export async function refreshChatGptAccount(accountId) {
  if (discoveryDisabled()) return false;
  if (!ACCOUNT_ID.test(accountId)) return false;
  const binary = findCodexBinary();
  if (!binary) return false;
  const command = spawnableCommand(binary, ["login", "status"]);
  const completed = await new Promise((resolve) => {
    let settled = false;
    const child = spawn(command.command, command.args, {
      ...command.options,
      env: { ...process.env, CODEX_HOME: accountHome(accountId) },
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, 30_000);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
  const session = profileSession(accountId);
  return completed && Boolean(session && !session.expired);
}

function affinityKey(conversationId) {
  return `openai\u0000${conversationId}`;
}

function trimAffinities(now = Date.now()) {
  for (const [key, value] of affinities) {
    if (now - value.at > AFFINITY_TTL_MS) affinities.delete(key);
  }
  while (affinities.size > MAX_AFFINITIES) affinities.delete(affinities.keys().next().value);
}

export function forgetChatGptAccountAffinities(accountId) {
  for (const [key, value] of affinities) {
    if (!accountId || value.accountId === accountId) affinities.delete(key);
  }
  if (accountId) cooldowns.delete(accountId);
}

export function selectChatGptAccountCandidates(callerHeaders, conversationId) {
  if (discoveryDisabled()) return [];
  const policy = readPolicy();
  const now = Date.now();
  trimAffinities(now);
  const candidates = [];
  const seenFingerprints = new Set();
  const callerAuthorized = typeof callerHeaders?.authorization === "string" && callerHeaders.authorization;
  if (callerAuthorized) {
    candidates.push({ id: DEFAULT_CHATGPT_ACCOUNT_ID, headers: { ...callerHeaders } });
    if (typeof callerHeaders["chatgpt-account-id"] === "string" && callerHeaders["chatgpt-account-id"]) {
      seenFingerprints.add(
        createHash("sha256").update(callerHeaders["chatgpt-account-id"]).digest("hex"),
      );
    }
  }
  // Additional profiles must not turn the router-local caller capability into
  // implicit permission to spend ChatGPT. A native caller either brings its
  // own OpenAI session or receives the explicitly consented shared session
  // before it reaches this selector.
  if (!callerAuthorized) return candidates;
  for (const entry of policy.accounts) {
    if (entry.state !== "active") continue;
    const session = profileSession(entry.id);
    if (!session || session.expired) continue;
    if (seenFingerprints.has(session.accountFingerprint)) continue;
    seenFingerprints.add(session.accountFingerprint);
    candidates.push({
      id: entry.id,
      headers: {
        ...callerHeaders,
        authorization: `Bearer ${session.accessToken}`,
        "chatgpt-account-id": session.accountId,
      },
    });
  }
  const sticky = conversationId ? affinities.get(affinityKey(conversationId))?.accountId : undefined;
  candidates.sort((left, right) => {
    const rank = (entry) => entry.id === sticky ? 0 : entry.id === policy.preferred ? 1 : 2;
    return rank(left) - rank(right);
  });
  const ready = candidates.filter((entry) => (cooldowns.get(entry.id) || 0) <= now);
  return ready.length ? ready : candidates;
}

export function rememberChatGptAccount(conversationId, accountId) {
  if (!conversationId) return;
  const key = affinityKey(conversationId);
  affinities.delete(key);
  affinities.set(key, { accountId, at: Date.now() });
  trimAffinities();
}

export function coolChatGptAccount(accountId, until) {
  forgetChatGptAccountAffinities(accountId);
  cooldowns.set(accountId, Math.max(Date.now() + 1_000, until || 0));
}

export function chatGptTransportFailure(signal, error) {
  if (signal?.aborted || error?.name === "AbortError") return { recoverable: false };
  return { recoverable: true, reason: "transport", until: Date.now() + TRANSPORT_COOLDOWN_MS };
}

export async function classifyChatGptAccountResponse(response) {
  const failure = await classifyProviderAccountResponse(response);
  if (failure.recoverable || !isRetryableStatus(response.status)) return failure;
  return { recoverable: true, reason: "transport", until: Date.now() + TRANSPORT_COOLDOWN_MS };
}
