function compactDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "00000000";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function taskNumberForBatchId(id, createdAt) {
  const compactId = String(id || "unknown").replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase().padEnd(8, "0");
  return `GC-${compactDate(createdAt)}-${compactId}`;
}

export function taskNumberForBatch(batch) {
  return typeof batch?.taskNumber === "string" && batch.taskNumber.trim()
    ? batch.taskNumber
    : taskNumberForBatchId(batch?.id, batch?.createdAt);
}

