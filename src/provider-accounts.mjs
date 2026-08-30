import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import {
  PROVIDER_ACCOUNT_CREDENTIALS_DIR,
  PROVIDER_ACCOUNT_POLICY_PATH,
  PROVIDER_CREDENTIAL_STORE_PATH,
  ROUTER_PLANE_TARGET,
  STATE_DIR,
} from "./paths.mjs";
import {
  addCredentialReference,
  readProviderCredentialStore,
  removeCredentialReference,
  writeProviderCredentialStore,
} from "./provider-credential-store.mjs";
import {
  apiProvider,
  resolveProviderCredential,
  resolveProviderCredentialReference,
} from "./provider-credentials.mjs";

export const DEFAULT_PROVIDER_ACCOUNT_ID = "default";
export const PROVIDER_ACCOUNT_POLICY = "sticky-fallback";

const ID = /^cred_[A-Za-z0-9_-]{16,64}$/;
const MAX_LABEL = 160;
const AFFINITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AFFINITIES = 5_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const affinities = new Map();
const cooldowns = new Map();

function canonical(provider) {
  return provider.variantOf || provider.id;
}

function supportsAdditionalAccounts(provider) {
  // Command Code's coding-plan fallback writes its translated stream directly
  // to the client, so it cannot be replayed before response bytes without a
  // provider-specific buffering redesign. Keep its existing single-account
  // behavior explicit instead of advertising a pool that only works on one of
  // its two entitlement routes.
  return canonical(provider) !== "commandcode";
}

function assertAdditionalAccountsSupported(provider) {
  if (!supportsAdditionalAccounts(provider)) {
    throw new Error("Command Code additional accounts are not supported by its direct coding-plan relay.");
  }
}

function cleanText(value, field, max = MAX_LABEL) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${field} must not be empty.`);
  if (text.length > max) throw new Error(`${field} is too long.`);
  return text;
}

function accountPath(id) {
  if (!ID.test(id)) throw new Error("Invalid provider account id.");
  return managedPath(path.join(PROVIDER_ACCOUNT_CREDENTIALS_DIR, `${id}.key`));
}

export function providerAccountCredentialPath(id) {
  return accountPath(id);
}

function assertRegularFile(filePath) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Provider account credential must be a regular file.");
  }
}

function managedPath(filePath) {
  const base = path.resolve(STATE_DIR);
  const target = path.resolve(filePath);
  const relative = path.relative(base, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Provider account state must stay inside the router state directory.");
  }
  let current = base;
  for (const component of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("Provider account state cannot traverse a symbolic link.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

function atomicPrivateFile(filePath, contents) {
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
    try { unlinkSync(temporary); } catch (cleanup) {
      if (cleanup?.code !== "ENOENT") error.cleanupError = cleanup;
    }
    throw error;
  }
}

function readPolicy({ strict = false } = {}) {
  if (!existsSync(PROVIDER_ACCOUNT_POLICY_PATH)) {
    return { schemaVersion: 1, policy: PROVIDER_ACCOUNT_POLICY, preferred: {} };
  }
  try {
    assertRegularFile(PROVIDER_ACCOUNT_POLICY_PATH);
    const parsed = JSON.parse(readFileSync(PROVIDER_ACCOUNT_POLICY_PATH, "utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.policy !== PROVIDER_ACCOUNT_POLICY ||
      !parsed.preferred ||
      typeof parsed.preferred !== "object" ||
      Array.isArray(parsed.preferred)
    ) throw new Error("invalid policy");
    const preferred = {};
    for (const [providerId, accountId] of Object.entries(parsed.preferred)) {
      if (/^[a-z0-9][a-z0-9-]{0,99}$/.test(providerId) &&
          (accountId === DEFAULT_PROVIDER_ACCOUNT_ID || ID.test(accountId))) {
        preferred[providerId] = accountId;
      }
    }
    return { schemaVersion: 1, policy: PROVIDER_ACCOUNT_POLICY, preferred };
  } catch (error) {
    if (strict) throw new Error("Provider account policy is malformed or unsafe.", { cause: error });
    return { schemaVersion: 1, policy: PROVIDER_ACCOUNT_POLICY, preferred: {} };
  }
}

function writePolicy(policy) {
  atomicPrivateFile(managedPath(PROVIDER_ACCOUNT_POLICY_PATH), `${JSON.stringify(policy, null, 2)}\n`);
}

function accountEntries(provider) {
  const providerId = canonical(provider);
  return readProviderCredentialStore().credentials.filter((entry) =>
    entry.providerId === providerId && entry.secretRef?.type === "account-file"
  );
}

function publicEntry(entry, preferred) {
  return {
    id: entry.id,
    label: entry.label || entry.account?.alias || entry.id,
    plan: entry.account?.plan || null,
    state: entry.state,
    preferred: entry.id === preferred,
    source: "protected account file",
  };
}

export function providerAccountsSnapshot(providerOrId) {
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  assertAdditionalAccountsSupported(provider);
  const providerId = canonical(provider);
  const preferred = readPolicy().preferred[providerId] || DEFAULT_PROVIDER_ACCOUNT_ID;
  const primary = resolveProviderCredential(provider);
  return {
    providerId,
    policy: PROVIDER_ACCOUNT_POLICY,
    preferred,
    accounts: [
      {
        id: DEFAULT_PROVIDER_ACCOUNT_ID,
        label: "Default credential",
        plan: null,
        state: primary ? "active" : "missing",
        preferred: preferred === DEFAULT_PROVIDER_ACCOUNT_ID,
        source: primary ? "configured default credential" : null,
      },
      ...accountEntries(provider).map((entry) => publicEntry(entry, preferred)),
    ],
  };
}

export function addProviderAccount(providerOrId, { value, label, plan, preferred = false } = {}) {
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  assertAdditionalAccountsSupported(provider);
  const providerId = canonical(provider);
  const secret = cleanText(value, "Provider account credential", 16 * 1024);
  const id = `cred_${randomBytes(18).toString("base64url")}`;
  const filePath = accountPath(id);
  atomicPrivateFile(filePath, `${secret}\n`);
  let entry;
  try {
    entry = addCredentialReference({
      id,
      providerId,
      kind: "api_key",
      secretRef: { type: "account-file", providerId, target: ROUTER_PLANE_TARGET, name: id },
      label: label ? cleanText(label, "Account label") : undefined,
      account: {
        ...(label ? { alias: cleanText(label, "Account label") } : {}),
        ...(plan ? { plan: cleanText(plan, "Account plan", 80) } : {}),
      },
      state: "active",
    });
  } catch (error) {
    try { unlinkSync(filePath); } catch (cleanup) {
      if (cleanup?.code !== "ENOENT") error.cleanupError = cleanup;
    }
    throw error;
  }
  if (preferred) setPreferredProviderAccount(provider, id);
  return publicEntry(entry, preferred ? id : readPolicy().preferred[providerId]);
}

export function setPreferredProviderAccount(providerOrId, accountId) {
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  assertAdditionalAccountsSupported(provider);
  const providerId = canonical(provider);
  if (accountId !== DEFAULT_PROVIDER_ACCOUNT_ID && !accountEntries(provider).some((entry) =>
    entry.id === accountId && entry.state === "active"
  )) throw new Error("Preferred provider account must exist and be active.");
  return withAtomicStateLock(PROVIDER_ACCOUNT_POLICY_PATH, () => {
    const policy = readPolicy({ strict: true });
    policy.preferred[providerId] = accountId;
    writePolicy(policy);
    return providerAccountsSnapshot(provider);
  });
}

export function setProviderAccountState(providerOrId, accountId, state) {
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  assertAdditionalAccountsSupported(provider);
  if (accountId === DEFAULT_PROVIDER_ACCOUNT_ID) {
    throw new Error("The default credential is managed with provider-key.");
  }
  if (!ID.test(accountId) || !["active", "paused"].includes(state)) {
    throw new Error("Invalid provider account state change.");
  }
  return withAtomicStateLock(PROVIDER_CREDENTIAL_STORE_PATH, () => {
    const store = readProviderCredentialStore();
    const entry = store.credentials.find((candidate) =>
      candidate.id === accountId && candidate.providerId === canonical(provider) &&
      candidate.secretRef?.type === "account-file"
    );
    if (!entry) throw new Error("Provider account was not found.");
    entry.state = state;
    entry.updatedAt = new Date().toISOString();
    writeProviderCredentialStore(store);
    if (state !== "active") forgetProviderAccountAffinities(canonical(provider), accountId);
    return providerAccountsSnapshot(provider);
  });
}

export function removeProviderAccount(providerOrId, accountId) {
  const provider = typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  assertAdditionalAccountsSupported(provider);
  if (accountId === DEFAULT_PROVIDER_ACCOUNT_ID || !ID.test(accountId)) {
    throw new Error("Only additional provider accounts can be removed here.");
  }
  const providerId = canonical(provider);
  if (!accountEntries(provider).some((entry) => entry.id === accountId)) return false;
  const removed = removeCredentialReference(accountId);
  if (!removed) return false;
  const filePath = accountPath(accountId);
  if (existsSync(filePath)) {
    assertRegularFile(filePath);
    unlinkSync(filePath);
  }
  const policy = readPolicy({ strict: true });
  if (policy.preferred[providerId] === accountId) {
    policy.preferred[providerId] = DEFAULT_PROVIDER_ACCOUNT_ID;
    writePolicy(policy);
  }
  forgetProviderAccountAffinities(providerId, accountId);
  return true;
}

function affinityKey(providerId, conversationId) {
  return `${providerId}\u0000${conversationId}`;
}

function cooldownKey(providerId, accountId) {
  return `${providerId}\u0000${accountId}`;
}

function trimAffinities(now = Date.now()) {
  for (const [key, value] of affinities) {
    if (now - value.at > AFFINITY_TTL_MS) affinities.delete(key);
  }
  while (affinities.size > MAX_AFFINITIES) affinities.delete(affinities.keys().next().value);
}

export function forgetProviderAccountAffinities(providerId, accountId) {
  for (const [key, value] of affinities) {
    if (key.startsWith(`${providerId}\u0000`) && (!accountId || value.accountId === accountId)) {
      affinities.delete(key);
    }
  }
  if (accountId) cooldowns.delete(cooldownKey(providerId, accountId));
}

export function selectProviderAccountCandidates(provider, conversationId) {
  const providerId = canonical(provider);
  if (!supportsAdditionalAccounts(provider)) {
    const credential = resolveProviderCredential(provider);
    return credential ? [{ id: DEFAULT_PROVIDER_ACCOUNT_ID, credential }] : [];
  }
  const now = Date.now();
  trimAffinities(now);
  const preferred = readPolicy().preferred[providerId] || DEFAULT_PROVIDER_ACCOUNT_ID;
  const candidates = [];
  const primary = resolveProviderCredential(provider);
  if (primary) candidates.push({ id: DEFAULT_PROVIDER_ACCOUNT_ID, credential: primary });
  for (const entry of accountEntries(provider)) {
    if (entry.state !== "active") continue;
    const credential = resolveProviderCredentialReference(provider, entry.secretRef);
    if (credential) candidates.push({ id: entry.id, credential });
  }
  const sticky = conversationId ? affinities.get(affinityKey(providerId, conversationId))?.accountId : undefined;
  candidates.sort((left, right) => {
    const rank = (entry) => entry.id === sticky ? 0 : entry.id === preferred ? 1 : 2;
    return rank(left) - rank(right);
  });
  const ready = candidates.filter((entry) => (cooldowns.get(cooldownKey(providerId, entry.id)) || 0) <= now);
  return ready.length ? ready : candidates;
}

export function rememberProviderAccount(provider, conversationId, accountId) {
  if (!conversationId) return;
  const providerId = canonical(provider);
  const key = affinityKey(providerId, conversationId);
  affinities.delete(key);
  affinities.set(key, { accountId, at: Date.now() });
  trimAffinities();
}

export function coolProviderAccount(provider, accountId, until) {
  const providerId = canonical(provider);
  forgetProviderAccountAffinities(providerId, accountId);
  cooldowns.set(cooldownKey(providerId, accountId), Math.max(Date.now() + 1_000, until || 0));
}

function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function boundedResponseText(response) {
  const clone = response.clone();
  if (!clone.body) return "";
  const reader = clone.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BODY_BYTES - size;
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function classifyProviderAccountResponse(response) {
  if (response.status === 429 || response.status === 402) {
    return {
      recoverable: true,
      reason: response.status === 429 ? "rate_limit" : "quota",
      until: Date.now() + (retryAfterMs(response.headers) || DEFAULT_FAILURE_COOLDOWN_MS),
    };
  }
  if (![403, 503].includes(response.status)) return { recoverable: false };
  let text = "";
  try {
    text = (await boundedResponseText(response)).toLowerCase();
  } catch {}
  const quota = /(?:quota|usage limit|credits? exhausted|insufficient[_ -]quota|billing limit)/.test(text);
  if (!quota) return { recoverable: false };
  return { recoverable: true, reason: "quota", until: Date.now() + DEFAULT_FAILURE_COOLDOWN_MS };
}

export function classifyProviderAccountTransportError(error, signal) {
  if (signal?.aborted || error?.name === "AbortError") return { recoverable: false };
  return {
    recoverable: true,
    reason: "transport",
    until: Date.now() + 30_000,
  };
}
