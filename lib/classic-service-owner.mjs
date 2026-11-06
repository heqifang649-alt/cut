import path from "node:path";
import { readJson } from "./atomic-json.mjs";

// Explicit opt-in; shared ownership must never use an interactive account.
export function classicServiceOwnerConfig(env) {
  return env.CUTFLOW_CLASSIC_SERVICE_OWNER_ENABLED === "true"
    ? { serviceOwnerId: env.CUTFLOW_CLASSIC_SERVICE_OWNER_ID || "" } : {};
}

export async function classicServiceOwner(root, config) {
  if (config.serviceOwnerId === undefined) return null;
  const id = config.serviceOwnerId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("INVALID_SERVICE_OWNER");
  const users = await readJson(path.join(root, "data/users.json"), []);
  const user = users.find(item => item.id === id);
  if (!user || user.status !== "disabled" || user.role !== "member") throw new Error("SERVICE_OWNER_MUST_BE_NONINTERACTIVE");
  return id;
}
