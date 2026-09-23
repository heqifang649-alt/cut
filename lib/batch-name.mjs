// Batch display names follow one fixed team convention:
//
//     <素材一级文件夹名><YY.M.D>-<当日批次序号>        例如 TT26.9.21-1
//
// The stamp is always Beijing time and is never zero padded, so one shoot day
// always maps to exactly one name prefix no matter which machine creates the
// batch. The sequence is derived from the names that already exist, which is
// why the counter lives outside the form as well.

const BEIJING_TIME_ZONE = "Asia/Shanghai";

const beijingDateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/**
 * Batch date stamp in Beijing time, e.g. `26.9.21`.
 * @param {Date | number | string} [value]
 * @returns {string}
 */
export function batchDateStamp(value = new Date()) {
  const candidate = value instanceof Date ? value : new Date(value);
  const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  const parts = beijingDateParts.formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "0";
  // `% 100` keeps the two digit year portable across locale/ICU differences.
  return `${Number(pick("year")) % 100}.${Number(pick("month"))}.${Number(pick("day"))}`;
}

/**
 * `TT` + today -> `TT26.9.21`. Returns an empty string when no folder is known.
 * @param {string} folderName
 * @param {Date | number | string} [value]
 * @returns {string}
 */
export function batchNamePrefix(folderName, value = new Date()) {
  const folder = String(folderName ?? "").trim();
  if (!folder) return "";
  return `${folder}${batchDateStamp(value)}`;
}

/**
 * Next free sequence for a prefix. Every existing batch name is inspected
 * (not just the caller's) because a shoot folder is shared by the whole team:
 * two people creating a batch from `TT` on the same day must not both get
 * `TT26.9.21-1`.
 * @param {readonly string[]} existingNames
 * @param {string} prefix
 * @returns {number}
 */
export function nextBatchSequence(existingNames, prefix) {
  if (!prefix) return 1;
  let highest = 0;
  for (const name of existingNames || []) {
    if (typeof name !== "string" || !name.startsWith(`${prefix}-`)) continue;
    const suffix = name.slice(prefix.length + 1);
    // The trailing `-` in the comparison keeps `TT26.9.2` from matching
    // `TT26.9.21-1`, and a non numeric suffix (e.g. a hand renamed batch) is
    // simply ignored instead of shifting the counter.
    if (!/^\d+$/.test(suffix)) continue;
    const value = Number(suffix);
    if (value > highest) highest = value;
  }
  return highest + 1;
}

/**
 * Full default batch name, e.g. `TT26.9.21-1`.
 * @param {string} folderName
 * @param {readonly string[]} existingNames
 * @param {Date | number | string} [value]
 * @returns {string}
 */
export function nextBatchName(folderName, existingNames, value = new Date()) {
  const prefix = batchNamePrefix(folderName, value);
  if (!prefix) return "";
  return `${prefix}-${nextBatchSequence(existingNames, prefix)}`;
}
