"use client";

import { useEffect, useMemo, useState } from "react";
import "./labeling.css";

type Label = { expectedVerdict: "accept" | "reject"; wrongSku: boolean; handArtifact: boolean; productError: boolean };
type DraftLabel = { expectedVerdict: Label["expectedVerdict"] | null; wrongSku: boolean | null; handArtifact: boolean | null; productError: boolean | null };
type Sample = { id: string; name: string; batchId: string; fileId: string; label: Label | null };
type Snapshot = { currentIndex: number; pilotLimit: number; progress: { total: number; completed: number; remaining: number }; samples: Sample[] };

const initialLabel: DraftLabel = { expectedVerdict: null, wrongSku: null, handArtifact: null, productError: null };

function completeLabel(value: DraftLabel): value is Label {
  return value.expectedVerdict !== null && value.wrongSku !== null && value.handArtifact !== null && value.productError !== null;
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
      setError("请先明确标注全部四项字段");
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
    <header className="labeling-head"><div><span>QUALITY GATE V2</span><h1>Pilot Ground Truth</h1></div><strong>{snapshot.progress.completed} / {snapshot.progress.total}</strong></header>
    <section className="labeling-workspace">
      <div className="labeling-video"><video key={sample.id} controls playsInline preload="metadata" src={`/api/benchmark/quality-gate-v2/pilot/${sample.id}/media`}>当前浏览器不支持视频预览</video><small>{index + 1} / {snapshot.pilotLimit} · {sample.name}</small></div>
      <form className="labeling-form" onSubmit={(event) => { event.preventDefault(); void persist("save"); }}>
        <fieldset><legend>expectedVerdict</legend><div className="choice-row"><button type="button" disabled={Boolean(label.wrongSku || label.handArtifact || label.productError)} className={label.expectedVerdict === "accept" ? "selected accept" : ""} onClick={() => { setLabel({ ...label, expectedVerdict: "accept" }); setSaved(false); }}>ACCEPT</button><button type="button" className={label.expectedVerdict === "reject" ? "selected reject" : ""} onClick={() => { setLabel({ ...label, expectedVerdict: "reject" }); setSaved(false); }}>REJECT</button></div></fieldset>
        {(["wrongSku", "handArtifact", "productError"] as const).map((field) => <fieldset key={field}><legend>{field}</legend><div className="choice-row"><button type="button" className={label[field] === false ? "selected" : ""} onClick={() => { setLabel({ ...label, [field]: false }); setSaved(false); }}>否</button><button type="button" className={label[field] === true ? "selected reject" : ""} onClick={() => { setLabel({ ...label, [field]: true, expectedVerdict: "reject" }); setSaved(false); }}>是</button></div></fieldset>)}
        {error && <p className="labeling-error">{error}</p>}
        <div className="labeling-actions"><button type="button" onClick={() => void move(index - 1)} disabled={busy || !saved || index === 0}>上一条</button><button type="submit" className="label-save" disabled={busy || saved || !completeLabel(label)}>{busy ? "保存中" : "保存"}</button><button type="button" onClick={() => void move(index + 1)} disabled={busy || !saved || index === snapshot.samples.length - 1}>下一条</button></div>
      </form>
    </section>
  </main>;
}
