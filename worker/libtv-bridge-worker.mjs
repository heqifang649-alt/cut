import { bridgeConfig, bridgeTick, writeBridgeHeartbeat } from "../lib/libtv-bridge.mjs";

const config = bridgeConfig();
const handoff = process.argv.find(arg => arg.startsWith('--handoff='))?.slice('--handoff='.length);
if (handoff) {
  if (!/^handoff-[0-9a-f-]{36}$/i.test(handoff)) throw new Error('INVALID_HANDOFF_SCOPE');
  config.allowedHandoffIds = [handoff];
}
const once = process.argv.includes("--once");
do {
  await writeBridgeHeartbeat(process.cwd(), config);
  await bridgeTick(process.cwd(), config);
  await writeBridgeHeartbeat(process.cwd(), config);
  if (!once) await new Promise((resolve) => setTimeout(resolve, 2000));
} while (!once);
