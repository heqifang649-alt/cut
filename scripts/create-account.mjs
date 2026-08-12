import { createUser } from "../lib/auth-core.mjs";

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const username = valueFor("--username");
const displayName = valueFor("--display-name") || username;
const role = valueFor("--role") || "member";
if (!username || !["admin", "member"].includes(role)) {
  console.error("Usage: node scripts/create-account.mjs --username <name> --display-name <name> --role <admin|member>");
  process.exitCode = 2;
} else {
  const user = await createUser(process.cwd(), { username, displayName, role });
  console.log(JSON.stringify(user));
}
