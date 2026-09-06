import {
  addChatGptAccount,
  chatGptAccountsSnapshot,
  chatGptAccountsUsage,
  refreshChatGptAccount,
  reloginChatGptAccount,
  removeChatGptAccount,
  renameChatGptAccount,
  setChatGptAccountOrder,
  setChatGptAccountPurpose,
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
    "       chatgpt-accounts usage",
    "       chatgpt-accounts add --label NAME [--preferred]",
    "       chatgpt-accounts rename default|ACCOUNT_ID --label NAME",
    "       chatgpt-accounts prefer default|ACCOUNT_ID",
    "       chatgpt-accounts order ACCOUNT_ID [ACCOUNT_ID...]",
    "       chatgpt-accounts purpose default|ACCOUNT_ID --purpose personal|auraone|veerone|foundation|reserve",
    "       chatgpt-accounts pause|resume|remove|refresh|login ACCOUNT_ID",
  ].join("\n");
}

if (!["list", "usage", "add", "rename", "prefer", "order", "purpose", "pause", "resume", "remove", "refresh", "login"].includes(command)) {
  throw new Error(usage());
}

let result;
if (command === "add") {
  result = { added: addChatGptAccount({ label: option("--label"), preferred: args.includes("--preferred") }) };
} else if (command === "rename") {
  if (!accountId) throw new Error(usage());
  result = renameChatGptAccount(accountId, option("--label"));
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
} else if (command === "order") {
  result = setChatGptAccountOrder(args.slice(1));
} else if (command === "purpose") {
  if (!accountId) throw new Error(usage());
  result = setChatGptAccountPurpose(accountId, option("--purpose"));
}

if (command === "usage") {
  process.stdout.write(`${JSON.stringify(await chatGptAccountsUsage({ cached: args.includes("--cached") }), null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ ...result, accounts: chatGptAccountsSnapshot() }, null, 2)}\n`);
}
