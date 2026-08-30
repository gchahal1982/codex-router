import {
  addProviderAccount,
  providerAccountsSnapshot,
  removeProviderAccount,
  setPreferredProviderAccount,
  setProviderAccountState,
} from "./provider-accounts.mjs";

const args = process.argv.slice(2);
const providerId = args[0];
const command = args[1] || "list";

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function stdinSecret() {
  if (process.stdin.isTTY) {
    throw new Error("Pipe the additional account credential on stdin; it is never accepted as a command argument.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("The provider account credential is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function usage() {
  return [
    "Usage: provider-accounts PROVIDER list",
    "       provider-accounts PROVIDER add [--label NAME] [--plan PLAN] [--preferred] < credential",
    "       provider-accounts PROVIDER prefer default|CREDENTIAL_ID",
    "       provider-accounts PROVIDER pause|resume|remove CREDENTIAL_ID",
  ].join("\n");
}

if (!providerId || !["list", "add", "prefer", "pause", "resume", "remove"].includes(command)) {
  throw new Error(usage());
}

if (command === "add") {
  const account = addProviderAccount(providerId, {
    value: await stdinSecret(),
    label: option("--label"),
    plan: option("--plan"),
    preferred: args.includes("--preferred"),
  });
  process.stdout.write(`${JSON.stringify({ added: account, ...providerAccountsSnapshot(providerId) }, null, 2)}\n`);
} else if (command === "prefer") {
  if (!args[2]) throw new Error(usage());
  process.stdout.write(`${JSON.stringify(setPreferredProviderAccount(providerId, args[2]), null, 2)}\n`);
} else if (command === "pause" || command === "resume") {
  if (!args[2]) throw new Error(usage());
  process.stdout.write(`${JSON.stringify(
    setProviderAccountState(providerId, args[2], command === "pause" ? "paused" : "active"),
    null,
    2,
  )}\n`);
} else if (command === "remove") {
  if (!args[2]) throw new Error(usage());
  const removed = removeProviderAccount(providerId, args[2]);
  process.stdout.write(`${JSON.stringify({ removed, ...providerAccountsSnapshot(providerId) }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(providerAccountsSnapshot(providerId), null, 2)}\n`);
}
