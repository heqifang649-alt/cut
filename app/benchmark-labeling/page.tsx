"use client";

import { useEffect, useMemo, useState } from "react";
import "./labeling.css";

type ArtifactField = "wrongSku" | "handArtifact" | "productError" | "bodyArtifact" | "objectArtifact" | "temporalArtifact";
type Label = { expectedVerdict: "accept" | "reject" } & Record<ArtifactField, boolean>;
type DraftLabel = { expectedVerdict: Label["expectedVerdict"] | null } & Record<ArtifactField, boolean | null>;
type Sample = { id: string; name: string; batchId: string; fileId: string; label: Label | null };
type Snapshot = { currentIndex: number; labelingLimit: number; progress: { total: number; completed: number; remaining: number }; samples: Sample[] };

const artifactFields: Array<{ field: ArtifactField; label: string; guidance?: string }> = [
  { field: "wrongSku", label: "wrongSku" },
  { field: "handArtifact", label: "handArtifact" },
  { field: "productError", label: "productError" },
  { field: "bodyArtifact", label: "bodyArtifact · 人体是否穿帮", guidance: "脸部、四肢、身体比例、穿模，或身体与衣物异常融合。" },
  { field: "objectArtifact", label: "objectArtifact · 物体/环境是否穿帮", guidance: "物品凭空出现或消失、物体变形、人和物体融合，或背景元素异常变化。" },
  { field: "temporalArtifact", label: "temporalArtifact · 是否存在时序异常", guidance: "闪烁、跳变、主体瞬移，或人脸、衣服、物体在连续帧中突然变化。" },
];
const initialLabel: DraftLabel = { expectedVerdict: null, wrongSku: null, handArtifact: null, productError: null, bodyArtifact: null, objectArtifact: null, temporalArtifact: null };

function completeLabel(value: DraftLabel): value is Label {
  return value.expectedVerdict !== null && artifactFields.every(({ field }) => value[field] !== null);
}

export default function BenchmarkLabelingPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [index, setIndex] = useState(0);
  const [label, setLabel] = useState<DraftLabel>(initialLabel);
  const [saved, setSaved] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sample = useMemo(() => snapshot?.samples[index] || null, [snapshot, index]);

  const apply = (data: Snapshot, nextIndex = data.currentIndex) => {
    setSnapshot(data);
    setIndex(nextIndex);
    setLabel(data.samples[nextIndex]?.label || initialLabel);
    setSaved(true);
  };

  useEffect(() => {
    fetch("/api/benchmark/quality-gate-v2/pilot", { cache: "no-store" })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "无法读取标注任务"); return data; })
      .then((data) => apply(data))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取标注任务"));
  }, []);

  const persist = async (action: "save" | "cursor", nextIndex = index) => {
    if (!sample) return false;
    if (action === "save" && !completeLabel(label)) {
      setError("请先明确标注全部七项字段");
      return false;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/benchmark/quality-gate-v2/pilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, sampleId: sample.id, label, currentIndex: nextIndex }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      apply(data, nextIndex);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
      return false;
    } finally { setBusy(false); }
  };

  const move = async (nextIndex: number) => {
    if (!snapshot || nextIndex < 0 || nextIndex >= snapshot.samples.length || busy || !saved) return;
    await persist("cursor", nextIndex);
  };

  if (error && !snapshot) return <main className="labeling-shell"><p className="labeling-error">{error}</p></main>;
  if (!snapshot || !sample) return <main className="labeling-shell"><p>正在载入 Pilot 标注…</p></main>;

  return <main className="labeling-shell">
    <header className="labeling-head"><div><span>QUALITY GATE V2</span><h1>Ground Truth Labeling</h1></div><strong>{snapshot.progress.completed} / {snapshot.progress.total}</strong></header>
    <section className="labeling-workspace">
      <div className="labeling-video"><video key={sample.id} controls playsInline preload="metadata" src={`/api/benchmark/quality-gate-v2/pilot/${sample.id}/media`}>当前浏览器不支持视频预览</video><small>{index + 1} / {snapshot.labelingLimit} · {sample.name}</small></div>
      <form className="labeling-form" onSubmit={(event) => { event.preventDefault(); void persist("save"); }}>
        <fieldset><legend>expectedVerdict</legend><div className="choice-row"><button type="button" disabled={artifactFields.some(({ field }) => label[field] === true)} className={label.expectedVerdict === "accept" ? "selected accept" : ""} onClick={() => { setLabel({ ...label, expectedVerdict: "accept" }); setSaved(false); }}>ACCEPT</button><button type="button" className={label.expectedVerdict === "reject" ? "selected reject" : ""} onClick={() => { setLabel({ ...label, expectedVerdict: "reject" }); setSaved(false); }}>REJECT</button></div></fieldset>
        {artifactFields.map(({ field, label: fieldLabel, guidance }) => <fieldset key={field}><legend>{fieldLabel}</legend>{guidance && <p className="field-guidance">{guidance}</p>}<div className="choice-row"><button type="button" className={label[field] === false ? "selected" : ""} onClick={() => { setLabel({ ...label, [field]: false }); setSaved(false); }}>否</button><button type="button" className={label[field] === true ? "selected reject" : ""} onClick={() => { setLabel({ ...label, [field]: true, expectedVerdict: "reject" }); setSaved(false); }}>是</button></div></fieldset>)}
        {error && <p className="labeling-error">{error}</p>}
        <div className="labeling-actions"><button type="button" onClick={() => void move(index - 1)} disabled={busy || !saved || index === 0}>上一条</button><button type="submit" className="label-save" disabled={busy || saved || !completeLabel(label)}>{busy ? "保存中" : "保存"}</button><button type="button" onClick={() => void move(index + 1)} disabled={busy || !saved || index === snapshot.samples.length - 1}>下一条</button></div>
      </form>
    </section>
  </main>;
}
