"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Batch, BatchStatus, NasScan, ProductDetection, ReferenceProfile, SampleTemplate } from "@/lib/types";

const statusMeta: Record<BatchStatus, { label: string; tone: string }> = {
  uploading: { label: "上传素材", tone: "muted" },
  reference_queued: { label: "等待识别样片", tone: "waiting" },
  analyzing_reference: { label: "正在识别样片", tone: "active" },
  creating_proxies: { label: "正在生成分析代理", tone: "active" },
  detecting_products: { label: "正在识别产品", tone: "active" },
  regroup_queued: { label: "等待识别产品", tone: "waiting" },
  reference_ready: { label: "待确认母版", tone: "review" },
  batch_queued: { label: "等待批量剪辑", tone: "waiting" },
  editing: { label: "统一剪辑中", tone: "active" },
  review: { label: "待审核成片", tone: "success" },
  revision_queued: { label: "等待修改", tone: "waiting" },
  revising: { label: "修改中", tone: "active" },
  cancel_requested: { label: "正在停止", tone: "danger" },
  canceled: { label: "已取消", tone: "muted" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "需要处理", tone: "danger" },
};

const defaultRequirements = `同一批素材使用同一脚本和同一剪辑结构。
成片控制在13秒以内，所有模特动作保持1.00×原速。
0–3秒用Hook抢停留；3–6秒建立穿搭兴趣；6秒以后展示正面、袖口、背面、面料等购买理由。
色彩参考样片，Hook位于顶部安全区，CVR参考样片的粗白字黑描边、表情和下指引导样式。`;

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

type NasScanView = NasScan & { preview: string[]; imagePreview?: string[] };
const cancelableStatuses: BatchStatus[] = ["uploading", "reference_queued", "analyzing_reference", "creating_proxies", "detecting_products", "regroup_queued", "reference_ready", "batch_queued", "editing", "revision_queued", "revising", "failed"];

function timeAgo(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60000) return "刚刚";
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.round(hours / 24)}天前`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function FileDrop({
  label,
  hint,
  files,
  accept,
  multiple,
  directory,
  onChange,
}: {
  label: string;
  hint: string;
  files: File[];
  accept?: string;
  multiple?: boolean;
  directory?: boolean;
  onChange: (files: File[]) => void;
}) {
  const directoryProps = directory ? ({ webkitdirectory: "", directory: "" } as Record<string, string>) : {};
  return (
    <label className={`file-drop ${files.length ? "has-files" : ""}`}>
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        {...directoryProps}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Array.from(event.target.files ?? []))}
      />
      <span className="file-icon">{files.length ? "✓" : "+"}</span>
      <span className="file-copy">
        <strong>{files.length ? `${label} · ${files.length}个文件` : label}</strong>
        <small>{files.length ? files.slice(0, 2).map((file) => file.name).join("、") : hint}</small>
      </span>
      <span className="file-action">选择</span>
    </label>
  );
}

function ProfilePanel({ profile }: { profile: ReferenceProfile }) {
  return (
    <div className="profile-panel">
      <div className="profile-head">
        <div>
          <span className="eyebrow">REFERENCE PROFILE</span>
          <h3>样片母版已识别</h3>
        </div>
        <div className="confidence">{Math.round(profile.confidence * 100)}% 匹配度</div>
      </div>
      <p className="profile-summary">{profile.summary}</p>
      <div className="profile-grid">
        <div><span>节奏</span><strong>{profile.pace}</strong></div>
        <div><span>调色</span><strong>{profile.color}</strong></div>
        <div><span>字幕安全区</span><strong>{profile.caption_safe_zone}</strong></div>
        <div><span>CVR样式</span><strong>{profile.cvr_style}</strong></div>
      </div>
      <div className="timeline-strip" aria-label="样片镜头结构">
        {profile.structure.map((item, index) => (
          <div key={`${item.timeline}-${index}`} style={{ flex: item.weight || 1 }}>
            <span>{item.timeline}</span>
            <strong>{item.purpose}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductDetectionPanel({ detection }: { detection: ProductDetection }) {
  return (
    <div className="detection-panel">
      <div className="profile-head">
        <div><span className="eyebrow">AUTO PRODUCT DETECTION</span><h3>自动识别到 {detection.groups.length} 款产品</h3></div>
        <div className="confidence">{Math.round(detection.confidence * 100)}% 总体置信度</div>
      </div>
      <p className="profile-summary">{detection.summary}</p>
      <div className="product-groups">
        {detection.groups.map((group, index) => (
          <div className="product-group" key={group.id}>
            <div className="group-number">{String(index + 1).padStart(2, "0")}</div>
            <div className="group-copy"><strong>{group.label}</strong><span>{group.signature}</span><small>{group.files.slice(0, 3).join(" · ")}{group.files.length > 3 ? ` 等${group.files.length}个视频` : ""}</small></div>
            <div className="group-score">{Math.round(group.confidence * 100)}%</div>
          </div>
        ))}
      </div>
      {!!detection.unassigned.length && <div className="unassigned">待人工确认：{detection.unassigned.join("、")}</div>}
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState<"batches" | "templates" | "reviews">("batches");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [templates, setTemplates] = useState<SampleTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [error, setError] = useState("");
  const [workerOnline, setWorkerOnline] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const activityAgeSec = useCallback((at?: string) => {
    if (!at) return Infinity;
    return Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  }, []);
  const activityClass = useCallback((age: number) => {
    if (age <= 30) return "activity-live";
    if (age <= 120) return "activity-stale";
    return "activity-dead";
  }, []);
  const activeStatuses = ["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising"];
  const [accountState, setAccountState] = useState<{ codex?: { ready?: boolean; response?: string }; chatcut?: { ready?: boolean } }>({});
  const [sourceMode, setSourceMode] = useState<"nas" | "upload">("nas");
  const [nasPath, setNasPath] = useState(String.raw`\\192.168.120.60\内容创意部-fb广告成片交付`);
  const [nasScan, setNasScan] = useState<NasScanView | null>(null);
  const [scanningNas, setScanningNas] = useState(false);

  const [batchName, setBatchName] = useState("GC街头信仰服装 · 统一脚本");
  const [requirements, setRequirements] = useState(defaultRequirements);
  const [durationMax, setDurationMax] = useState(13);
  const [outputCount, setOutputCount] = useState(1);
  const [cvrText, setCvrText] = useState("One of our best sellers.");
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [productFiles, setProductFiles] = useState<File[]>([]);
  const [productReferenceFiles, setProductReferenceFiles] = useState<File[]>([]);
  const [lutFiles, setLutFiles] = useState<File[]>([]);
  const [hookFiles, setHookFiles] = useState<File[]>([]);
  const [bgmFiles, setBgmFiles] = useState<File[]>([]);
  const [revision, setRevision] = useState("");
  const [groupCommand, setGroupCommand] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("街头服装 13秒母版");
  const [templateFiles, setTemplateFiles] = useState<File[]>([]);
  const [templateSubmitting, setTemplateSubmitting] = useState(false);
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>({});

  const loadBatches = useCallback(async () => {
    try {
      const [batchResponse, healthResponse, templateResponse] = await Promise.all([
        fetch("/api/batches", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/templates", { cache: "no-store" }),
      ]);
      if (batchResponse.ok) {
        const data = (await batchResponse.json()) as { batches: Batch[] };
        setBatches(data.batches);
        setSelectedId((current) => current ?? data.batches[0]?.id ?? null);
      }
      if (healthResponse.ok) {
        const health = (await healthResponse.json()) as { workerOnline: boolean; codex?: { ready?: boolean; response?: string }; chatcut?: { ready?: boolean } };
        setWorkerOnline(health.workerOnline);
        setAccountState({ codex: health.codex, chatcut: health.chatcut });
      }
      if (templateResponse.ok) {
        const data = (await templateResponse.json()) as { templates: SampleTemplate[] };
        setTemplates(data.templates);
        setSelectedTemplateId((current) => current || data.templates.find((item) => item.status === "ready")?.id || "");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBatches();
    const timer = window.setInterval(loadBatches, 3500);
    return () => window.clearInterval(timer);
  }, [loadBatches]);

  const selected = useMemo(() => batches.find((batch) => batch.id === selectedId) ?? null, [batches, selectedId]);
  const reviewBatches = useMemo(() => batches.filter((batch) => ["review", "completed"].includes(batch.status) && batch.files.some((file) => file.kind === "output")), [batches]);
  const completedCount = reviewBatches.length;
  const activeCount = batches.filter((batch) => ["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising", "cancel_requested"].includes(batch.status)).length;

  async function approveBatch(batch: Batch) {
    setError("");
    try {
      const response = await fetch(`/api/batches/${batch.id}/approve`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "确认成片失败");
      await loadBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "确认成片失败");
    }
  }

  async function retryChatCut(batchId: string, fileId: string) {
    setError("");
    try {
      const response = await fetch(`/api/batches/${batchId}/chatcut/${fileId}/retry`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法重新同步 ChatCut 项目");
      await loadBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法重新同步 ChatCut 项目");
    }
  }

  async function scanNasDirectory() {
    setError("");
    setScanningNas(true);
    setNasScan(null);
    try {
      const response = await fetch("/api/nas/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: nasPath }),
      });
      const payload = (await response.json()) as { scan?: NasScanView; error?: string };
      if (!response.ok || !payload.scan) throw new Error(payload.error || "NAS 目录扫描失败");
      setNasPath(payload.scan.rootPath);
      setNasScan(payload.scan);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "NAS 目录扫描失败");
    } finally {
      setScanningNas(false);
    }
  }

  async function uploadFile(batchId: string, kind: string, file: File) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: {
        "x-batch-id": batchId,
        "x-file-kind": kind,
        "x-file-name": encodeURIComponent(file.name),
        "x-relative-path": encodeURIComponent(relativePath),
        "x-file-size": String(file.size),
      },
      body: file,
    });
    if (!response.ok) throw new Error((await response.json()).error || `上传 ${file.name} 失败`);
  }

  async function createBatch(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!selectedTemplateId && !referenceFiles[0]) return setError("请选择已拆解的样片母版，或临时上传一条样片。");
    if (sourceMode === "nas" && (!nasScan || nasScan.rootPath !== nasPath)) return setError("请先检查 NAS 目录，确认视频数量后再提交。");
    if (sourceMode === "upload" && !productFiles.length) return setError("请选择本批次的服装素材文件夹或视频文件。");
    setSubmitting(true);
    try {
      const response = await fetch("/api/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchName, requirements, durationMax, outputCount, cvrText, speed: 1, sourceMode, nasPath: sourceMode === "nas" ? nasPath : undefined, templateId: selectedTemplateId || undefined }),
      });
      const payload = (await response.json()) as { batch?: Batch; error?: string };
      if (!response.ok || !payload.batch) throw new Error(payload.error || "创建批次失败");
      const batch = payload.batch;
      setSelectedId(batch.id);
      const groups = [
        ["reference", selectedTemplateId ? [] : referenceFiles],
        ["products", sourceMode === "upload" ? productFiles : []],
        ["product_refs", productReferenceFiles],
        ["lut", lutFiles],
        ["hooks", hookFiles],
        ["bgm", bgmFiles],
      ] as const;
      const total = groups.reduce((sum, [, files]) => sum + files.length, 0);
      let uploaded = 0;
      for (const [kind, files] of groups) {
        for (const file of files) {
          setUploadState(`正在上传 ${uploaded + 1}/${total} · ${file.name}`);
          await uploadFile(batch.id, kind, file);
          uploaded += 1;
        }
      }
      if (sourceMode === "nas") {
        setUploadState("正在登记 NAS 原片路径，不复制原视频…");
        const attachResponse = await fetch(`/api/batches/${batch.id}/attach-nas`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: nasPath }),
        });
        const attachPayload = await attachResponse.json();
        if (!attachResponse.ok) throw new Error(attachPayload.error || "NAS 素材挂载失败");
      }
      setUploadState("素材已就绪，正在加入样片识别队列…");
      const queueResponse = await fetch(`/api/batches/${batch.id}/queue-reference`, { method: "POST" });
      if (!queueResponse.ok) throw new Error("样片识别任务入队失败");
      setReferenceFiles([]);
      setProductFiles([]);
      setProductReferenceFiles([]);
      setLutFiles([]);
      setHookFiles([]);
      setBgmFiles([]);
      if (sourceMode === "nas") setNasScan(null);
      await loadBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交失败");
    } finally {
      setSubmitting(false);
      setUploadState("");
    }
  }

  async function approveProfile() {
    if (!selected) return;
    await fetch(`/api/batches/${selected.id}/approve-profile`, { method: "POST" });
    await loadBatches();
  }

  async function submitRevision() {
    if (!selected || !revision.trim()) return;
    await fetch(`/api/batches/${selected.id}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: revision.trim() }),
    });
    setRevision("");
    await loadBatches();
  }

  async function submitRegroup() {
    if (!selected || !groupCommand.trim()) return;
    await fetch(`/api/batches/${selected.id}/regroup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: groupCommand.trim() }),
    });
    setGroupCommand("");
    await loadBatches();
  }

  async function cancelBatch(batch: Batch) {
    if (!window.confirm(`确定停止“${batch.name}”吗？已生成的文件会保留。`)) return;
    const response = await fetch(`/api/batches/${batch.id}/cancel`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) setError(payload.error || "取消任务失败");
    await loadBatches();
  }

  async function deleteBatch(batch: Batch) {
    if (!window.confirm(`确定删除“${batch.name}”吗？该任务的所有记录会从历史中移除（已生成的 MP4 文件保留在磁盘）。`)) return;
    const response = await fetch(`/api/batches/${batch.id}/delete`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || "删除任务失败"); return; }
    setExpandedBatches((prev) => { const next = { ...prev }; delete next[batch.id]; return next; });
    await loadBatches();
  }

  async function createSampleTemplate(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!templateFiles[0]) return setError("请先选择一条参考样片。");
    setTemplateSubmitting(true);
    try {
      const createResponse = await fetch("/api/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: templateName }) });
      const created = await createResponse.json();
      if (!createResponse.ok || !created.template) throw new Error(created.error || "创建母版失败");
      const uploadResponse = await fetch("/api/template-uploads", { method: "POST", headers: { "x-template-id": created.template.id, "x-file-name": encodeURIComponent(templateFiles[0].name) }, body: templateFiles[0] });
      if (!uploadResponse.ok) throw new Error((await uploadResponse.json()).error || "样片上传失败");
      const queueResponse = await fetch(`/api/templates/${created.template.id}/queue`, { method: "POST" });
      if (!queueResponse.ok) throw new Error((await queueResponse.json()).error || "母版分析入队失败");
      setTemplateFiles([]);
      await loadBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "母版提交失败");
    } finally {
      setTemplateSubmitting(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>GC</span><div><strong>Cutflow</strong><small>统一剪辑工作台</small></div></div>
        <nav aria-label="主要导航">
          <button className={`nav-item ${view === "batches" ? "active" : ""}`} onClick={() => setView("batches")}><span>▦</span>批次任务<i>{batches.length}</i></button>
          <button className={`nav-item ${view === "templates" ? "active" : ""}`} onClick={() => setView("templates")}><span>◫</span>样片母版<i>{templates.filter((item) => item.status === "ready").length}</i></button>
          <button className={`nav-item ${view === "reviews" ? "active" : ""}`} onClick={() => setView("reviews")}><span>✓</span>成片审核<i>{completedCount}</i></button>
        </nav>
        <div className="sidebar-note">
          <span className={`status-dot ${workerOnline ? "online" : ""}`} />
          <div><strong>{workerOnline ? "剪辑工作机在线" : "剪辑工作机未连接"}</strong><small>{workerOnline ? "任务会自动处理" : "启动本地Worker后自动接单"}</small></div>
        </div>
        <div className="user-card"><span>EE</span><div><strong>内容创意部</strong><small>局域网团队空间</small></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><span className="eyebrow">BATCH CREATIVE SYSTEM</span><h1>{view === "templates" ? "样片母版库" : view === "reviews" ? "成片审核" : "统一母版批量剪辑"}</h1><p>{view === "templates" ? "提前上传并拆解样片，批次提交时直接复用结构，省去现场等待。" : view === "reviews" ? "逐条预览成片，确认通过后自动交付到成片目录。" : "选择已拆解母版，让整批服装共享同一脚本、节奏、色彩和CVR规范。"}</p></div>
          <div className="top-stats"><div><strong>{activeCount}</strong><span>处理中</span></div><div><strong>{completedCount}</strong><span>待审核/完成</span></div></div>
        </header>

        {!loading && (!workerOnline || !accountState.codex?.ready) && (
          <div className="safe-mode-banner">
            <span className="safe-mode-icon">⚠</span>
            <div>
              <strong>自动剪辑暂停 — 等待账号恢复</strong>
              <small>
                {!workerOnline && <>剪辑工作机未连接，当前任务不会开始处理。</>}
                {!workerOnline && !accountState.codex?.ready ? " " : null}
                {!accountState.codex?.ready && <>Codex 账号不可用{accountState.codex?.response ? `（${accountState.codex.response}）` : null}，自动剪辑不接单。</>}
              </small>
            </div>
            <small className="safe-mode-action">恢复后双击 <code>scripts\restart-cutflow.cmd</code> 重新连接</small>
          </div>
        )}

        {!loading && workerOnline && accountState.codex?.ready && !accountState.chatcut?.ready && (
          <div className="safe-mode-banner chatcut-only">
            <span className="safe-mode-icon">i</span>
            <div>
              <strong>自动剪辑正常；ChatCut 待连接</strong>
              <small>MP4 成片会正常生成，仅“可编辑项目链接”暂时不会创建。</small>
            </div>
            <small className="safe-mode-action">无需暂停当前任务</small>
          </div>
        )}

        {view === "batches" ? <>
        <div className="content-grid">
          <section className="creation-card">
            <div className="section-head"><div><span className="step-badge">NEW</span><h2>创建统一剪辑批次</h2></div><span className="speed-lock">动作固定 1.00×</span></div>
            <div className="stepper"><div className="on"><b>1</b><span>选择母版</span></div><i/><div className="on"><b>2</b><span>连接素材</span></div><i/><div className="on"><b>3</b><span>自动分产品</span></div><i/><div><b>4</b><span>确认分组</span></div></div>

            <form onSubmit={createBatch}>
              <div className="field-row two">
                <label><span>批次名称</span><input value={batchName} onChange={(event) => setBatchName(event.target.value)} required /></label>
                <label><span>CVR文案</span><input value={cvrText} onChange={(event) => setCvrText(event.target.value)} required /></label>
              </div>

              <div className="upload-grid source-grid">
                <div className="template-source-card">
                  <label><span>样片母版</span><select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">临时上传新样片</option>{templates.filter((item) => item.status === "ready").map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                  {selectedTemplateId ? <div className="template-ready"><span>✓</span><div><strong>结构母版已就绪</strong><small>{templates.find((item) => item.id === selectedTemplateId)?.profile?.summary || "提交后跳过样片识别"}</small></div></div> : <FileDrop label="上传临时样片" hint="建议先到样片母版页提前拆解" files={referenceFiles} accept="video/*" onChange={(files) => setReferenceFiles(files.slice(0, 1))} />}
                </div>
                <div className="source-picker">
                  <div className="source-tabs" role="tablist" aria-label="原片接入方式">
                    <button type="button" className={sourceMode === "nas" ? "active" : ""} onClick={() => setSourceMode("nas")}>NAS直读 <b>推荐</b></button>
                    <button type="button" className={sourceMode === "upload" ? "active" : ""} onClick={() => setSourceMode("upload")}>浏览器上传</button>
                  </div>
                  {sourceMode === "nas" ? (
                    <div className="nas-source">
                      <div className="nas-input"><input value={nasPath} onChange={(event) => { setNasPath(event.target.value); setNasScan(null); }} placeholder="\\服务器\共享目录\本次拍摄" aria-label="NAS素材目录"/><button type="button" onClick={scanNasDirectory} disabled={scanningNas}>{scanningNas ? "检查中…" : "检查并扫描"}</button></div>
                      {nasScan ? <div className="nas-result"><span>✓</span><div><strong>目录可读 · {nasScan.fileCount} 个视频 · {nasScan.imageCount || 0} 张产品图 · {formatSize(nasScan.totalSize)}</strong><small>{nasScan.speedMBps ? `实测读取约 ${nasScan.speedMBps} MB/s · ` : ""}视频和产品图均留在 NAS，仅在本机建立分析索引</small></div></div> : <p>粘贴本次拍摄文件夹路径，目录内的产品图会被自动发现并辅助识别。</p>}
                    </div>
                  ) : <FileDrop label="选择本次拍摄全部视频" hint="备用方式：视频将逐个上传到剪辑工作机" files={productFiles} accept="video/*" multiple directory onChange={setProductFiles} />}
                </div>
              </div>

              <div className="product-reference-row">
                <div className="product-reference-copy"><span>可选增强</span><strong>产品参考图</strong><small>上传商品图、平铺图或SKU图，帮助正面、背面和细节视频准确归入同一款。NAS目录里的图片会自动读取。</small></div>
                <FileDrop label="补充产品图文件夹" hint="JPG / PNG / WebP，可一次选择整文件夹" files={productReferenceFiles} accept="image/*" multiple directory onChange={setProductReferenceFiles} />
              </div>

              <div className="auto-detect-banner"><span>AI</span><div><strong>自动检测产品已开启</strong><small>系统会结合视频多帧与产品参考图，识别同款衣服的正面、背面和细节镜头；分组确认后才开始剪辑。</small></div><b>固定开启</b></div>

              <label className="full-field"><span>全批次统一脚本与要求</span><textarea value={requirements} onChange={(event) => setRequirements(event.target.value)} rows={6} /></label>

              <div className="field-row settings">
                <label><span>最长时长</span><div className="unit-input"><input type="number" min="6" max="30" value={durationMax} onChange={(event) => setDurationMax(Number(event.target.value))} /><em>秒</em></div></label>
                <label><span>每款输出</span><div className="unit-input"><input type="number" min="1" max="5" value={outputCount} onChange={(event) => setOutputCount(Number(event.target.value))} /><em>条</em></div></label>
                <label><span>Hook策略</span><select defaultValue="library"><option value="library">从文案库统一匹配</option><option value="sample">完全跟随样片</option></select></label>
                <label><span>色彩策略</span><select defaultValue="sample"><option value="sample">LUT＋匹配样片</option><option value="lut">仅应用LUT</option></select></label>
              </div>

              <details className="assets-details">
                <summary>附加统一资源 <span>LUT、Hook库、BGM</span></summary>
                <div className="mini-upload-grid">
                  <FileDrop label="LUT文件" hint=".cube" files={lutFiles} accept=".cube" onChange={(files) => setLutFiles(files.slice(0, 1))} />
                  <FileDrop label="Hook文案库" hint=".docx / .txt" files={hookFiles} accept=".docx,.txt" onChange={(files) => setHookFiles(files.slice(0, 1))} />
                  <FileDrop label="BGM素材" hint="可多选" files={bgmFiles} accept="audio/*,video/*" multiple onChange={setBgmFiles} />
                </div>
              </details>

              {error && <div className="error-banner">{error}</div>}
              <div className="submit-row"><p>{uploadState || (selectedTemplateId ? "已使用预拆解母版，提交后直接进入产品代理与分类。" : "临时样片需要先完成识别，之后才会进入产品分类。")}</p><button className="primary-button" disabled={submitting}>{submitting ? "正在提交…" : selectedTemplateId ? "创建批次并识别产品 →" : "识别样片并创建批次 →"}</button></div>
            </form>
          </section>

          <aside className="queue-card">
            <div className="section-head"><div><span className="eyebrow">LIVE QUEUE</span><h2>任务队列</h2></div><button className="icon-button" onClick={loadBatches} aria-label="刷新任务">↻</button></div>
            <div className="queue-list">
              {loading && <div className="empty-state">正在读取任务…</div>}
              {!loading && !batches.length && <div className="empty-state"><strong>还没有批次</strong><span>左侧提交第一批素材后，样片会先进入识别队列。</span></div>}
              {batches.map((batch) => {
                const meta = statusMeta[batch.status];
                return (
                  <div key={batch.id} className={`queue-item ${selectedId === batch.id ? "selected" : ""}`}>
                    <button className="queue-main" onClick={() => setSelectedId(batch.id)}>
                      <div className="queue-title"><strong>{batch.name}</strong><span className={`pill ${meta.tone}`}>{meta.label}</span></div>
                      <div className={`progress-track ${activeStatuses.includes(batch.status) ? "is-active" : ""}`}><span style={{ width: `${batch.progress}%` }} /></div>
                      <div className="queue-meta"><span>{batch.renderingLabel || `${batch.files.filter((file) => file.kind === "products").length}个素材 · ${batch.sourceMode === "nas" ? "NAS直读" : "本机"}`}</span><span>{(() => {
                        if (batch.lastWorkerActivityAt && activeStatuses.includes(batch.status)) {
                          const age = activityAgeSec(batch.lastWorkerActivityAt);
                          const cls = activityClass(age);
                          const label = age <= 30 ? `活动 ${age}s` : age <= 120 ? `${age}s 前` : `${Math.round(age / 60)}分钟前`;
                          return <><span className={cls}><span className="pulse-dot" />{label}</span></>;
                        }
                        return timeAgo(batch.updatedAt);
                      })()}</span></div>
                    </button>
                    {cancelableStatuses.includes(batch.status) && batch.status !== "cancel_requested" && <button className="queue-cancel" onClick={() => cancelBatch(batch)} aria-label={`取消${batch.name}`}>×</button>}
                  </div>
                );
              })}
            </div>
          </aside>
        </div>

        {selected && (
          <section className="batch-detail">
            <div className="detail-head">
              <div><span className="eyebrow">SELECTED BATCH</span><h2>{selected.name}</h2><p>{statusMeta[selected.status].label}{selected.lastWorkerActivityAt && activeStatuses.includes(selected.status) ? (() => { const age = activityAgeSec(selected.lastWorkerActivityAt); return <> · <span className={activityClass(age)}><span className="pulse-dot" />{age <= 30 ? `活动中 ${age}s` : age <= 120 ? `${age}s 前刷新` : `${Math.round(age / 60)}分钟未刷新`}</span></>; })() : null} · {selected.files.length}个文件 · {selected.sourceMode === "nas" ? "NAS原片直读" : "本机素材"} · 最长{selected.durationMax}秒 · 原速</p></div>
              <span className={`large-status ${statusMeta[selected.status].tone}`}>{selected.progress}%</span>
            </div>
            {selected.referenceProfile ? <ProfilePanel profile={selected.referenceProfile} /> : (
              <div className={`analysis-placeholder ${activeStatuses.includes(selected.status) && selected.status !== "failed" ? "is-working" : ""}`}><div className="radar"><i/><i/><span>AI</span></div><div><strong>{selected.status === "failed" ? "任务需要处理" : "等待样片识别结果"}{activeStatuses.includes(selected.status) && selected.status !== "failed" ? <span className="live-dots" /> : null}</strong><p>{selected.error || "剪辑工作机会读取样片，提取镜头时长、转场、字幕安全区、色彩和CVR样式。"}{selected.lastWorkerActivityAt && activeStatuses.includes(selected.status) && selected.status !== "failed" ? <> <span className={activityClass(activityAgeSec(selected.lastWorkerActivityAt))}>已分析 {activityAgeSec(selected.lastWorkerActivityAt)} 秒</span></> : null}</p></div></div>
            )}
            {selected.productDetection ? <ProductDetectionPanel detection={selected.productDetection} /> : selected.referenceProfile && (
              <div className="analysis-placeholder compact is-working"><div className="radar"><i/><i/><span>衣</span></div><div><strong>正在自动识别产品<span className="live-dots" /></strong><p>无需文件夹分类，系统正在比较所有视频中的衣服底色、图案、号码、袖口与正反面关系。{selected.lastWorkerActivityAt ? <> <span className={activityClass(activityAgeSec(selected.lastWorkerActivityAt))}>已分析 {activityAgeSec(selected.lastWorkerActivityAt)} 秒</span></> : null}</p></div></div>
            )}
            {selected.renderSummary && <div className="quality-summary"><strong>本轮成片：{selected.renderSummary.renderedProducts}款 · 质量门禁全部通过</strong>{selected.renderSummary.excludedProducts.length > 0 && <p>主动排除 {selected.renderSummary.excludedProducts.length} 款：{selected.renderSummary.excludedProducts.map((item) => `${item.product_id}（${item.reason}）`).join("；")}</p>}</div>}
            <div className="detail-actions">
              {cancelableStatuses.includes(selected.status) && selected.status !== "cancel_requested" && <button className="cancel-button" onClick={() => cancelBatch(selected)}>取消当前任务</button>}
              {selected.status === "reference_ready" && selected.productDetection && <><input value={groupCommand} onChange={(event) => setGroupCommand(event.target.value)} placeholder="分组有误？例如：第02和03组是同一款，请合并"/><button className="secondary-button" onClick={submitRegroup} disabled={!groupCommand.trim()}>重新分组</button><button className="primary-button" onClick={approveProfile}>确认产品分组与母版，开始剪辑 →</button></>}
              {["review", "completed"].includes(selected.status) && <><input value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="例如：整批肤色再冷一点，Hook向下移动20px"/><button className="secondary-button" onClick={submitRevision}>提交整批修改</button></>}
              {["failed", "canceled"].includes(selected.status) && <button className="secondary-button" onClick={() => fetch(`/api/batches/${selected.id}/queue-reference`, { method: "POST" }).then(loadBatches)}>重新加入队列</button>}
            </div>
          </section>
        )}
        </> : view === "templates" ? (
          <section className="template-library">
            <div className="template-create">
              <div className="section-head"><div><span className="step-badge">PREP</span><h2>提前拆解新样片</h2></div><span className="speed-lock">一次分析 · 多批复用</span></div>
              <p>样片上传后独立分析镜头结构、色彩、Hook安全区、CVR和卡点。以后创建批次直接选择母版。</p>
              <form onSubmit={createSampleTemplate}>
                <label><span>母版名称</span><input value={templateName} onChange={(event) => setTemplateName(event.target.value)} /></label>
                <FileDrop label="上传参考样片" hint="建议选择已确认效果的广告成片" files={templateFiles} accept="video/*" onChange={(files) => setTemplateFiles(files.slice(0, 1))} />
                {error && <div className="error-banner">{error}</div>}
                <button className="primary-button template-submit" disabled={templateSubmitting}>{templateSubmitting ? "正在上传…" : "上传并开始结构拆解 →"}</button>
              </form>
            </div>
            <div className="template-list-panel">
              <div className="section-head"><div><span className="eyebrow">REUSABLE PROFILES</span><h2>可复用母版</h2></div><button className="icon-button" onClick={loadBatches}>↻</button></div>
              <div className="template-cards">
                {!templates.length && <div className="empty-state"><strong>还没有母版</strong><span>上传第一条确认过的样片，提前完成结构拆解。</span></div>}
                {templates.map((item) => <div className={`template-card ${item.status}`} key={item.id}>
                  <div className="template-card-head"><div><strong>{item.name}</strong><small>{item.file?.name || "等待上传"}</small></div><span>{item.status === "ready" ? "已就绪" : item.status === "analyzing" ? "拆解中" : item.status === "failed" ? "失败" : "排队中"}</span></div>
                  <div className="template-card-main">
                    {item.file && <div className="template-preview"><video controls playsInline preload="metadata" src={`/api/templates/${item.id}/media`} aria-label={`${item.name}样片预览`}>当前浏览器不支持视频预览</video></div>}
                    <div className="template-card-copy">
                      <div className="progress-track"><span style={{ width: `${item.progress}%` }} /></div>
                      {item.status === "analyzing" && item.lastWorkerActivityAt && <small className="template-activity">活动 {timeAgo(item.lastWorkerActivityAt)}{item.recoveryAttempts ? ` · 已自动重试${item.recoveryAttempts}次` : ""}</small>}
                      {item.profile ? <><p>{item.profile.summary}</p><div className="template-tags"><span>{item.profile.pace}</span><span>{item.profile.color}</span><span>{item.profile.structure.length}段结构</span></div></> : <p>{item.error || "后台会自动提取节奏、色彩、字幕安全区和CVR布局。"}</p>}
                    </div>
                  </div>
                </div>)}
              </div>
            </div>
          </section>
        ) : (
          <section className="review-library">
            <div className="section-head review-heading"><div><span className="eyebrow">FINAL VIDEO QC</span><h2>待审核与已通过成片</h2></div><button className="icon-button" onClick={loadBatches} aria-label="刷新成片">↻</button></div>
            {error && <div className="error-banner">{error}</div>}
            {!reviewBatches.length ? (
              <div className="review-empty"><strong>目前没有可审核的成片</strong><span>只有实际生成 MP4 的任务才会出现在这里。当前批次尚未完成渲染，请先到“批次任务”处理错误。</span><button className="secondary-button" onClick={() => setView("batches")}>返回批次任务</button></div>
            ) : (
              <div className="review-batches">
                {reviewBatches.map((batch) => {
                  const outputs = batch.files.filter((file) => file.kind === "output");
                  const isExpanded = expandedBatches[batch.id] ?? false;
                  const canCancel = ["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising", "reference_ready", "reference_queued", "regroup_queued", "batch_queued", "uploading"].includes(batch.status);
                  const canDelete = ["review", "completed", "canceled", "failed"].includes(batch.status);
                  const toggle = () => setExpandedBatches((prev) => ({ ...prev, [batch.id]: !isExpanded }));
                  return <article className={`review-batch ${isExpanded ? "expanded" : "collapsed"}`} key={batch.id}>
                    <div className="review-batch-head">
                      <button className="review-batch-toggle" onClick={toggle} aria-expanded={isExpanded} aria-label={isExpanded ? "折叠" : "展开"}>
                        <span className="review-batch-arrow">{isExpanded ? "▾" : "▸"}</span>
                        <div className="review-batch-meta">
                          <strong>{batch.name}</strong>
                          <small>{outputs.length} 条成片 · 创建于 {formatTime(batch.createdAt)} · {batch.durationMax}秒以内 · 动作1.00× · {batch.renderSummary ? "质量门禁已通过" : "等待质检摘要"}</small>
                          {batch.status === "completed" && batch.delivery && <small className="delivery-note">交付：{batch.delivery.status === "delivered" ? "已复制到成片目录" : batch.delivery.status === "copying" ? "正在复制" : batch.delivery.status === "failed" ? `失败：${batch.delivery.error || "请重试"}` : "等待交付 Worker"}</small>}
                        </div>
                      </button>
                      <div className="review-batch-tools">
                        <span className={`pill ${batch.status === "completed" ? "success" : "review"}`}>{batch.status === "completed" ? "已通过" : "待审核"}</span>
                        {canCancel && <button className="danger-button" onClick={() => cancelBatch(batch)} aria-label={`取消${batch.name}`}>取消任务</button>}
                        {canDelete && <button className="danger-button" onClick={() => deleteBatch(batch)} aria-label={`删除${batch.name}`}>删除记录</button>}
                      </div>
                    </div>
                    {isExpanded && <>
                      {batch.renderSummary?.excludedProducts.length ? <div className="review-warning">有 {batch.renderSummary.excludedProducts.length} 款因素材不足或同款无法确认而未生成，已避免混款成片。</div> : null}
                      <div className="review-videos">
                        {outputs.map((file) => <div className="review-video" key={file.id}>
                          <video controls playsInline preload="metadata" src={`/api/batches/${batch.id}/media/${file.id}`}>当前浏览器不支持视频预览</video>
                          <div className="review-video-copy"><span title={file.name}>{file.name}</span><small>{file.qualityStatus === "passed" ? `质检通过 · ${file.musicName || "独立音乐"}` : formatSize(file.size)}</small><div className="review-video-links"><a href={`/api/batches/${batch.id}/media/${file.id}?download=1`}>下载 MP4</a>{file.chatcut?.manifestPath && <a href={`/api/batches/${batch.id}/chatcut/${file.id}/manifest`}>剪辑清单</a>}{file.chatcut?.status === "ready" && file.chatcut.editorUrl && <a href={file.chatcut.editorUrl} target="_blank" rel="noreferrer">打开 ChatCut</a>}{file.chatcut?.status && file.chatcut.status !== "ready" && <span className={`chatcut-status ${file.chatcut.status}`}>{file.chatcut.status === "pending" ? "等待同步 ChatCut" : file.chatcut.status === "syncing" ? `正在创建 ChatCut 项目${file.chatcut.lastActivityAt ? ` · 活动 ${timeAgo(file.chatcut.lastActivityAt)}` : ""}` : file.chatcut.status === "needs_auth" ? "需要登录 ChatCut" : "ChatCut 同步失败"}</span>}{["needs_auth", "failed"].includes(file.chatcut?.status || "") && <button className="chatcut-retry" onClick={() => retryChatCut(batch.id, file.id)}>重新同步</button>}</div>{file.chatcut?.error && <small className="chatcut-error" title={file.chatcut.error}>{file.chatcut.error}</small>}</div>
                        </div>)}
                      </div>
                      <div className="review-actions"><button className="secondary-button" onClick={() => { setSelectedId(batch.id); setView("batches"); }}>返回修改</button>{batch.status === "review" && <button className="primary-button" onClick={() => approveBatch(batch)}>确认通过并交付</button>}</div>
                    </>}
                  </article>;
                })}
              </div>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
