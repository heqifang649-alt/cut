import path from "node:path";

const normalizedRelativePath = (value) => String(value || "").replaceAll("/", "\\").replace(/^\\+/, "").toLocaleLowerCase("zh-CN");

function relativeProductFolder(value) {
  const parts = String(value || "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : null;
}

function evidenceStem(value) {
  return String(path.basename(value || ""))
    .replace(/\.[^.]+$/, "")
    .replace(/\s*(?:\(\d+\)\s*)+$/, "")
    .trim()
    .toLocaleLowerCase("zh-CN");
}

function productReferenceKeys(group) {
  const values = [group?.id, group?.label, ...(Array.isArray(group?.files) ? group.files : [])];
  const keys = new Set();
  for (const value of values) {
    const stem = evidenceStem(value);
    if (!stem) continue;
    keys.add(stem);
    const withoutModel = stem.replace(/(?:[-_\s]+)(?:m|model)[a-z0-9-]+$/i, "");
    if (withoutModel) keys.add(withoutModel);
  }
  return [...keys].sort((left, right) => right.length - left.length);
}

function productReferenceNameScore(file, keys) {
  const stem = evidenceStem(file?.relativePath || file?.name);
  let best = 0;
  for (const key of keys) {
    if (stem === key) best = Math.max(best, 100 + key.length);
    if (!stem.startsWith(key)) continue;
    const suffix = stem.slice(key.length).replace(/^[-_\s]+/, "");
    if (!suffix) best = Math.max(best, 100 + key.length);
    else if (/^(?:正面?|front)(?:[-_\s\d].*)?$/i.test(suffix)) best = Math.max(best, 90 + key.length);
    else if (/^(?:主图|产品图|商品图|参考图|product|reference|ref)(?:[-_\s\d].*)?$/i.test(suffix)) best = Math.max(best, 80 + key.length);
    else if (/^(?:反面?|背面|back)(?:[-_\s\d].*)?$/i.test(suffix)) best = Math.max(best, 70 + key.length);
    else if (/^(?:细节|侧面|detail|details|side)(?:[-_\s\d].*)?$/i.test(suffix)) best = Math.max(best, 60 + key.length);
  }
  return best;
}

function uniqueFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    const key = normalizedRelativePath(file?.relativePath || file?.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function productReferencesForGroup(group, productReferenceFiles, limit = 2) {
  const candidates = Array.isArray(productReferenceFiles) ? productReferenceFiles : [];
  const declared = Array.isArray(group?.productReferenceFiles) ? group.productReferenceFiles : [];
  const selected = declared.flatMap((source) => candidates.filter((file) => normalizedRelativePath(file.relativePath) === normalizedRelativePath(source)));
  const notes = normalizedRelativePath(group?.notes).replaceAll("\\", "");
  selected.push(...candidates.filter((file) => {
    const relativePath = normalizedRelativePath(file.relativePath).replaceAll("\\", "");
    const fileName = normalizedRelativePath(path.basename(file.relativePath || file.name)).replaceAll("\\", "");
    return notes && (notes.includes(relativePath) || notes.includes(fileName));
  }));
  if (group?.sourceFolder) {
    selected.push(...candidates.filter((file) => relativeProductFolder(file.relativePath)?.toLocaleLowerCase("zh-CN") === group.sourceFolder.toLocaleLowerCase("zh-CN")));
  }
  const keys = productReferenceKeys(group);
  selected.push(...candidates
    .map((file, index) => ({ file, index, score: productReferenceNameScore(file, keys) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.file));
  const matched = uniqueFiles(selected);
  if (!matched.length && candidates.length === 1) matched.push(candidates[0]);
  return matched.slice(0, Math.max(1, Number(limit) || 1));
}

export function productReferenceForGroup(group, productReferenceFiles) {
  return productReferencesForGroup(group, productReferenceFiles, 1)[0] || null;
}
