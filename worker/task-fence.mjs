const OPERATION_STATUSES = {
  reference: new Set(["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products"]),
  regroup: new Set(["regroup_queued", "detecting_products"]),
  quality: new Set(["batch_queued", "editing"]),
  edit: new Set(["editing"]),
  revision: new Set(["revision_queued", "revising"]),
  render: new Set(["editing", "revising"]),
};

export function workflowVersionOf(record) {
  const value = Number(record?.workflowVersion);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function taskMatchesBatchVersion(task, batch) {
  return workflowVersionOf(task) === workflowVersionOf(batch);
}

export function taskMayOperate(task, batch, marker = null) {
  if (!taskMatchesBatchVersion(task, batch)) return false;
  const statuses = OPERATION_STATUSES[task.operation];
  if (!statuses?.has(batch?.status)) return false;
  if (task.operation === "quality" && (marker?.next === "clip" || marker?.next === "render") && workflowVersionOf(marker) === workflowVersionOf(task)) return false;
  if (task.operation === "render" && (marker?.next !== "render" || (marker.workflowVersion && workflowVersionOf(marker) !== workflowVersionOf(task)))) return false;
  return true;
}

// A stage may publish its next marker before its current lease is completed.
// Permit only the owner's final Batch write while the workflow version and
// resulting Batch status still match that stage.
export function taskMayFinalize(task, batch, marker = null) {
  if (!taskMatchesBatchVersion(task, batch)) return false;
  if (taskMayOperate(task, batch, marker)) return true;
  const finishedStates = {
    reference: ["reference_ready", "batch_queued"],
    regroup: ["reference_ready", "batch_queued"],
    quality: ["editing"],
    edit: ["editing"],
    revision: ["revising"],
    render: ["review", "failed"],
  };
  return Boolean(finishedStates[task.operation]?.includes(batch.status));
}
