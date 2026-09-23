// Pure logic for confirming product detection during the `reference_ready`
// stage. Kept free of filesystem and framework dependencies so it can be unit
// tested in isolation and reused by both the approve-profile API route and the
// worker consumption path.
//
// A "decision" for an unassigned file is either:
//   - { file, groupId: "<groupId>" }  -> assign to that product group
//   - { file, groupId: null }         -> explicit exclude ("本次不使用")
// Every unassigned file must be decided exactly once.

// Convert a raw <select> value from the UI into a normalized decision.
//   ""            -> not yet chosen (blocks confirmation)
//   "EXCLUDE"     -> explicit exclude (groupId null)
//   "<groupId>"   -> assign to that group
export function normalizeRawSelection(rawValue) {
  if (rawValue === "" || rawValue === null || rawValue === undefined) return { chosen: false };
  if (rawValue === "EXCLUDE") return { chosen: true, groupId: null };
  return { chosen: true, groupId: String(rawValue) };
}

// Build the assignment list the API expects from the UI selection map.
// Unhandled files (raw value "") are intentionally omitted so the backend can
// enforce that every unassigned file is decided.
export function selectionsToAssignments(selections, unassigned) {
  const result = [];
  for (const file of unassigned || []) {
    const raw = selections ? selections[file] : undefined;
    const decision = normalizeRawSelection(raw);
    if (!decision.chosen) continue;
    result.push({ file, groupId: decision.groupId });
  }
  return result;
}

// How many unhandled files remain (used to disable the confirm button).
export function countUnhandled(selections, unassigned) {
  let count = 0;
  for (const file of unassigned || []) {
    const decision = normalizeRawSelection(selections ? selections[file] : undefined);
    if (!decision.chosen) count += 1;
  }
  return count;
}

// Validate that every unassigned file is decided exactly once, that group ids
// are valid and uniquely owned, and that referenced files really exist on disk.
// `resolveExists(relativePath) => boolean` is optional (skips the disk check,
// e.g. in unit tests). Synchronous so it can run inside a synchronous mutate
// callback.
export function validateConfirmation({ detection, assignments, currentVersion, providedVersion, resolveExists }) {
  if (!detection || !Array.isArray(detection.groups) || !Array.isArray(detection.unassigned)) {
    throw new Error("产品识别数据不完整，无法确认。");
  }
  if (typeof providedVersion === "number" && providedVersion !== currentVersion) {
    throw new Error("批次工作流版本已变化，请刷新后重新确认。");
  }

  const assignmentList = Array.isArray(assignments) ? assignments : [];
  const unassigned = detection.unassigned;

  // Every unassigned file must appear exactly once.
  const seen = new Map();
  for (const entry of assignmentList) {
    if (!entry || typeof entry.file !== "string") throw new Error("确认项格式错误：缺少文件。");
    if (seen.has(entry.file)) throw new Error(`文件「${entry.file}」被重复决策。`);
    const gid = entry.groupId;
    if (gid !== null && (typeof gid !== "string" || gid.length === 0)) {
      throw new Error(`文件「${entry.file}」的确认值无效。`);
    }
    if (gid !== null && !detection.groups.some((group) => group.id === gid)) {
      throw new Error(`文件「${entry.file}」指向了不存在的产品组 ${gid}。`);
    }
    seen.set(entry.file, entry);
  }

  const assignedFiles = new Set(seen.keys());
  for (const file of unassigned) {
    if (!assignedFiles.has(file)) throw new Error(`有待确认文件未决策：「${file}」。`);
  }
  for (const file of assignedFiles) {
    if (!unassigned.includes(file)) throw new Error(`确认项包含未知文件：「${file}」。`);
  }

  // Unique group membership: a file must not already belong to another group,
  // and each group may only gain a file once.
  const membership = new Map();
  for (const group of detection.groups) membership.set(group.id, new Set(group.files || []));
  for (const entry of assignmentList) {
    if (entry.groupId === null || entry.groupId === undefined) continue; // excluded
    const gid = String(entry.groupId);
    for (const [otherGid, members] of membership) {
      if (otherGid === gid) continue;
      if (members.has(entry.file)) throw new Error(`文件「${entry.file}」已属于产品组 ${otherGid}，不能重复归属。`);
    }
    const set = membership.get(gid);
    if (!set.has(entry.file)) set.add(entry.file);
  }

  // Optional real-on-disk existence check.
  if (typeof resolveExists === "function") {
    for (const file of unassigned) {
      let exists = false;
      try {
        exists = resolveExists(file) === true;
      } catch {
        exists = false;
      }
      if (!exists) throw new Error(`文件「${file}」在磁盘上不存在，无法确认。`);
    }
  }

  return true;
}

// Apply the assignments to the AI detection without mutating the input.
// Excluded files are recorded but kept out of every group. AI confidence and
// other group metadata are preserved untouched.
export function applyConfirmation(detection, assignments = []) {
  const groups = detection.groups.map((group) => ({ ...group, files: [...(group.files || [])] }));
  const excluded = [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const entry of assignments) {
    if (entry.groupId === null || entry.groupId === undefined) {
      excluded.push(entry.file);
      continue;
    }
    const group = byId.get(String(entry.groupId));
    if (!group) continue; // guarded by validateConfirmation
    if (!group.files.includes(entry.file)) group.files.push(entry.file);
  }
  return { groups, excluded };
}

// Build the product-groups.json artifact the worker consumes. Mirrors the shape
// the worker itself writes (groups + unassigned + the original detection
// metadata) so all downstream consumers stay consistent.
export function buildProductGroupsArtifact(detection, confirmedGroups, excluded) {
  const artifact = { ...detection, groups: confirmedGroups, unassigned: [], excluded };
  delete artifact.humanConfirmation;
  return artifact;
}

// Worker consumption seam: prefer the batch's human-confirmed productDetection
// (single source of truth) when present, otherwise fall back to the on-disk
// product-groups.json artifact. This keeps the worker robust even if the
// artifact write lags the batches.json mutation.
export function resolveProductGroupsForConsumption(productDetection, fallbackGroups) {
  if (
    productDetection &&
    Array.isArray(productDetection.groups) &&
    productDetection.groups.length > 0 &&
    Array.isArray(productDetection.unassigned) &&
    productDetection.unassigned.length === 0 &&
    productDetection.humanConfirmation
  ) {
    return productDetection.groups;
  }
  return fallbackGroups;
}
