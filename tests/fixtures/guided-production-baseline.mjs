// Captured production selector, 2026-11-09. No Provider/render/state operations.
import {createProductViews,enforceMinimumSafeDuration,scheduleProductView} from '../../worker/shot-scheduler.mjs';
function productGroups(sources) {
  const groups = new Map();
  for (const source of sources) {
    const current = groups.get(source.bindingKey) || { id: source.bindingKey, label: source.bindingKey, files: [] };
    current.files.push(source.absolutePath);
    groups.set(source.bindingKey, current);
  }
  return [...groups.values()];
}

export function scheduleClassicMultisource({ record, shotPool, scriptTemplate, semanticEvidence }) {
  const views = createProductViews({ shotPool, productGroups: productGroups(record.sources) });
  return views.map((view) => ({ product: view.product, sourceNamesByShotId: view.sourceNamesByShotId,
    scheduleResult: scheduleAvailable(view, record, scriptTemplate, semanticEvidence) }));
}

function scheduleAvailable(view, record, scriptTemplate, semanticEvidence) {
  const planned = enforceMinimumSafeDuration(scheduleProductView({ batchId: record.taskId, productView: view, scriptTemplate,
      createdAt: record.acceptedAt, semanticEvidence, allowPartial: true, preserveSourceOrder: true }));
  if (new Set(view.shots.map(s => s.source)).size > 1 && planned.status === "success") return planned;
  const sourceOrder = new Map(record.sources.map((s,i) => [s.id, s.order ?? i]));
  const ends = new Map();
  const shots = [...view.shots].filter(s => !s.reject && !(semanticEvidence?.records || []).some(r => r.shotId === s.id && (r.wrongSku === true || ["reject", "wrong_sku"].includes(String(r.status).toLowerCase()) || r.result?.usable === false))).sort((a,b) => (sourceOrder.get(a.source) ?? 0)-(sourceOrder.get(b.source) ?? 0) || a.start-b.start).filter(s => {
    if (s.start < (ends.get(s.source) ?? 0)) return false;
    ends.set(s.source, s.end); return true;
  });
  if (!shots.length) return planned;
  return enforceMinimumSafeDuration({ status: "success", renderPlan: { id: `${record.taskId}-${view.product.id}-continuous`, batchId: record.taskId, createdAt: record.acceptedAt, transitionProfile: "hard_cut", slots: shots.map((shot,i) => ({ shot, slot: { id: `segment_${i}`, label: "商品展示", requireTags: [], targetDuration: shot.end-shot.start } })) } });
}
