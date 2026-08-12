import { readJson, withFileLock, writeJsonAtomic } from "../../lib/atomic-json.mjs";

const [file, countText] = process.argv.slice(2);
const count = Math.max(1, Number(countText) || 1);

for (let index = 0; index < count; index += 1) {
  await withFileLock(file, async () => {
    const value = await readJson(file, { count: 0 });
    value.count += 1;
    await writeJsonAtomic(file, value);
  }, { timeoutMs: 20_000 });
}
