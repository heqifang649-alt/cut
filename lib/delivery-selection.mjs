export function selectDeliveryBatch(batches, deliveredIds, selectedBatchId = null) {
  return batches.find((batch) => batch.status === "completed" && !deliveredIds.has(batch.id)
    && (!selectedBatchId || batch.id === selectedBatchId)) || null;
}
