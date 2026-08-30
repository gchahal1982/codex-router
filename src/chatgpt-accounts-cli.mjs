import {
  addChatGptAccount,
  chatGptAccountsSnapshot,
  refreshChatGptAccount,
  reloginChatGptAccount,
  removeChatGptAccount,
  setChatGptAccountState,
  setPreferredChatGptAccount,
} from "./chatgpt-accounts.mjs";

const args = process.argv.slice(2);
const command = args[0] || "list";
const accountId = args[1];

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function usage() {
  return [
    "Usage: chatgpt-accounts list",
    "       chatgpt-accounts add --label NAME [--preferred]",
    "       chatgpt-accounts prefer default|ACCOUNT_ID",
    "       chatgpt-accounts pause|resume|remove|refresh|login ACCOUNT_ID",
  ].join("\n");
}

if (!["list", "add", "prefer", "pause", "resume", "remove", "refresh", "login"].includes(command)) {
  throw new Error(usage());
}

let result;
if (command === "add") {
  result = { added: addChatGptAccount({ label: option("--label"), preferred: args.includes("--preferred") }) };
} else if (command === "prefer") {
  if (!accountId) throw new Error(usage());
  result = setPreferredChatGptAccount(accountId);
} else if (command === "pause" || command === "resume") {
  if (!accountId) throw new Error(usage());
  result = setChatGptAccountState(accountId, command === "pause" ? "paused" : "active");
} else if (command === "remove") {
  if (!accountId) throw new Error(usage());
  result = { removed: removeChatGptAccount(accountId) };
} else if (command === "refresh") {
  if (!accountId) throw new Error(usage());
  result = { refreshed: await refreshChatGptAccount(accountId) };
} else if (command === "login") {
  if (!accountId) throw new Error(usage());
  result = { login: reloginChatGptAccount(accountId) };
}

process.stdout.write(`${JSON.stringify({ ...result, accounts: chatGptAccountsSnapshot() }, null, 2)}\n`);
