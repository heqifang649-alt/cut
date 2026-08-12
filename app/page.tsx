"use client";

import { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { Batch, BatchStatus, NasScan, ProductDetection, ReferenceProfile, SampleTemplate, TransitionMode, TransitionProfile } from "@/lib/types";
import DashboardOverview, { type DashboardSnapshot } from "./dashboard-overview";

type RecoveryEvent = { at: string; message: string; tone: "active" | "success" | "failed" | "waiting" };
type RecoverySnapshot = { state?: "idle" | "recovering" | "retry_ready" | "recovered" | "manual_required" | "failed"; events?: RecoveryEvent[] };
type FailureDiagnostic = {
  id: string;
  occurredAt: string;
  service: string;
  stage: string;
  workerInstance: string;
  exceptionMessage: string;
  errorCode?: string;
  exitCode?: number;
  stderr?: string;
  fullLog: string;
  businessContext?: RenderReadinessDiagnostic;
};
type FailureDiagnosticsSnapshot = { latest?: FailureDiagnostic | null; events?: FailureDiagnostic[]; updatedAt?: string };
type ArtifactEvidence = { type: string; startTime: number; endTime: number; bbox?: { x: number; y: number; width: number; height: number } | null; consecutiveFrames: number; confidence: number; evidence?: { frames?: number[]; sampleFps?: number }; rawResponse?: unknown };
type ArtifactEvidenceSource = { sourceKey: string; source?: { fileId?: string; name?: string; videoPath?: string }; analyzer?: { status?: string; error?: string }; evidence?: ArtifactEvidence[]; gate?: { verdict?: "accept" | "review" | "reject"; reason?: string }; review?: { decision: "accept" | "reject"; decidedAt: string; note?: string } };
type ArtifactEvidenceSnapshot = { generatedAt?: string; sources?: ArtifactEvidenceSource[] };
type ProductGroupEvidence = { groupId: string; label: string; videoThumbnailUrl: string | null; productImageThumbnailUrl: string | null };
type ProductGroupEvidenceSnapshot = { groups?: ProductGroupEvidence[] };
type AppView = "dashboard" | "batches" | "new-batch" | "batch-detail" | "templates" | "reviews" | "users";
type AuthUser = { id: string; username: string; displayName: string; role: "admin" | "member" };
type ManagedUser = AuthUser & { status: "active" | "disabled"; createdAt: string; updatedAt: string };
type NewUserDraft = { username: string; role: "admin" | "member" };
type NewBatchDraft = {
  expiresAt: number;
  batchName: string;
  requirements: string;
  durationMax: number;
  outputCount: number;
  cvrText: string;
  hookText: string;
  cvrOverrideEnabled: boolean;
  hookOverrideEnabled: boolean;
  sourceMode: "nas" | "upload";
  nasPath: string;
  selectedTemplateId: string;
  colorStrategy: "none" | "sample" | "lut";
  musicSource: "template" | "library" | "upload";
  transitionMode: TransitionMode;
};
type RenderReadinessProduct = { productId: string; sourceCount: number; acceptShots: number; schedule: { status: string; reason?: string; missingSlot?: string }; excludedReason?: string };
type RenderReadinessDiagnostic = {
  kind: "render_readiness";
  failureNode: { code: string; label: string; detail: string };
  productView: { detectedProducts: number; createdViews: number; empty: boolean };
  qualityGate: { accept: number; review: number; reject: number; status: string; allRejected: boolean };
  scheduler: { status: string; failedProducts: number };
  edl: { exists: boolean; status: string; productsWritten: number; blockedReason?: string; sourceReadFailed: boolean };
  products: RenderReadinessProduct[];
};

const statusMeta: Record<BatchStatus, { label: string; tone: string }> = {
  uploading: { label: "等待素材上传", tone: "muted" },
  reference_queued: { label: "等待 Worker", tone: "muted" },
  analyzing_reference: { label: "AI 检测中", tone: "active" },
  creating_proxies: { label: "扫描素材中", tone: "active" },
  detecting_products: { label: "产品识别中", tone: "active" },
  regroup_queued: { label: "等待 Worker", tone: "muted" },
  reference_ready: { label: "等待确认", tone: "review" },
  batch_queued: { label: "等待 Worker", tone: "muted" },
  editing: { label: "自动排片中", tone: "active" },
  review: { label: "等待审核", tone: "review" },
  revision_queued: { label: "等待 Worker", tone: "muted" },
  revising: { label: "渲染中", tone: "active" },
  cancel_requested: { label: "正在取消", tone: "danger" },
  canceled: { label: "已取消", tone: "muted" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
};

const lifecycleStages = ["扫描素材", "产品识别", "AI质量检测", "自动排片", "视频渲染"] as const;

function lifecycleIndex(batch: Batch) {
  const label = `${batch.renderingLabel || ""} ${batch.status}`.toLowerCase();
  if (["review", "completed"].includes(batch.status)) return 4;
  if (label.includes("渲染") || label.includes("字幕") || label.includes("合成") || label.includes("编码") || label.includes("output")) return 4;
  if (label.includes("排片") || label.includes("schedule") || batch.status === "editing" || batch.status === "revising") return 3;
  if (label.includes("质量") || label.includes("shotpool") || batch.status === "batch_queued" || batch.status === "revision_queued") return 2;
  if (["detecting_products", "regroup_queued", "reference_ready"].includes(batch.status)) return 1;
  return 0;
}

function lifecycleCurrent(batch: Batch) {
  if (batch.status === "failed" && batch.renderingLabel === "Clip 未生成可渲染 EDL") return { label: "Clip 未生成可渲染 EDL", detail: batch.error || "未找到可通过校验的剪辑计划，渲染已被阻断。" };
  if (batch.status === "failed" && batch.renderingLabel === "等待人工处理") return { label: "等待人工处理", detail: batch.error || "自动恢复未成功，需要人工检查素材或运行环境。" };
  if (batch.status === "failed") return { label: "失败", detail: batch.error || "任务未完成，请查看失败原因。" };
  if (batch.status === "review") return { label: "等待审核", detail: "成片已生成，等待人工确认。" };
  if (batch.status === "completed") return { label: "已完成", detail: "成片已通过并完成交付。" };
  if (batch.status === "reference_ready") return { label: "等待确认", detail: "产品分组与样片母版等待确认。" };
  if (["reference_queued", "regroup_queued", "batch_queued", "revision_queued"].includes(batch.status)) return { label: "等待 Worker", detail: "任务已进入队列，等待工作机接手。" };
  if (batch.status === "uploading") return { label: "等待素材上传", detail: "正在接入本批素材。" };
  return { label: statusMeta[batch.status].label, detail: batch.renderingLabel || `已接入 ${batch.files.filter((file) => file.kind === "products").length} 个素材，正在处理。` };
}

function estimateRemaining(batch: Batch) {
  const active = ["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising"].includes(batch.status);
  if (!active || batch.progress < 5 || batch.progress >= 100) return null;
  const elapsedSeconds = Math.max(1, (Date.now() - new Date(batch.createdAt).getTime()) / 1000);
  const remainingSeconds = Math.round((elapsedSeconds / batch.progress) * (100 - batch.progress));
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 30) return "预计即将完成";
  return `预计剩余约 ${Math.max(1, Math.round(remainingSeconds / 60))} 分钟`;
}

function activityClassStatic(age: number) {
  if (age <= 30) return "activity-live";
  if (age <= 120) return "activity-stale";
  return "activity-dead";
}

function BatchLifecycle({ batch, compact = false }: { batch: Batch; compact?: boolean }) {
  const currentIndex = lifecycleIndex(batch);
  const current = lifecycleCurrent(batch);
  const estimate = estimateRemaining(batch);
  return <div className={`batch-lifecycle ${compact ? "compact" : ""}`}>
    <div className="lifecycle-current"><div><span>当前阶段</span><strong>{current.label}</strong><small>{current.detail}</small></div><div className="lifecycle-live"><span className={batch.lastWorkerActivityAt ? activityClassStatic(activityAgeSecStatic(batch.lastWorkerActivityAt)) : "activity-dead"}><i />{batch.lastWorkerActivityAt ? `最后更新 ${timeAgo(batch.lastWorkerActivityAt)}` : "暂无 Worker 更新"}</span>{estimate && <small>{estimate}</small>}</div></div>
    <div className="lifecycle-stages" aria-label="任务阶段进度">{lifecycleStages.map((stage, index) => {
      const failed = batch.status === "failed" && index === currentIndex;
      const state = failed ? "failed" : index < currentIndex ? "done" : index === currentIndex ? "current" : "pending";
      const icon = state === "done" ? "✓" : state === "current" ? "⏳" : state === "failed" ? "!" : "○";
      const detail = state === "current" ? current.label : state === "done" ? "已完成" : state === "failed" ? "已中断" : "未开始";
      return <div className={`lifecycle-stage ${state}`} key={stage}><i>{icon}</i><span>{stage}</span><small>{detail}</small></div>;
    })}</div>
  </div>;
}

function activityAgeSecStatic(at?: string) {
  if (!at) return Infinity;
  return Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
}

function BatchActivityTimeline({ batch, recoveryEvents = [] }: { batch: Batch; recoveryEvents?: RecoveryEvent[] }) {
  const current = lifecycleCurrent(batch);
  const events = [
    { at: batch.createdAt, text: "任务已创建，等待开始处理", tone: "waiting" },
    ...(batch.lastWorkerActivityAt ? [{ at: batch.lastWorkerActivityAt, text: `${current.label}：${current.detail}`, tone: batch.status === "failed" ? "failed" : "active" }] : []),
    ...(batch.status === "review" ? [{ at: batch.updatedAt, text: "视频渲染完成，任务进入等待审核", tone: "review" }] : []),
    ...(batch.status === "completed" ? [{ at: batch.updatedAt, text: "审核通过，任务已完成", tone: "success" }] : []),
    ...(batch.status === "failed" && batch.error ? [{ at: batch.updatedAt, text: `${batch.renderingLabel === "等待人工处理" || batch.renderingLabel === "Clip 未生成可渲染 EDL" ? batch.renderingLabel : "任务失败"}：${batch.error}`, tone: "failed" }] : []),
    ...recoveryEvents.map((event) => ({ at: event.at, text: event.message, tone: event.tone })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return <div className="activity-timeline"><strong>已知任务记录</strong><small>记录基于当前已保存的状态与 Worker 最近活动，不伪造未记录的阶段数据。</small>{events.map((event, index) => <div className={`timeline-event ${event.tone}`} key={`${event.at}-${index}`}><time>{formatTime(event.at).slice(11)}</time><i>{event.tone === "success" ? "✓" : event.tone === "failed" ? "!" : event.tone === "active" ? "⏳" : "○"}</i><span>{event.text}</span></div>)}</div>;
}

function RenderReadinessPanel({ diagnostic }: { diagnostic: RenderReadinessDiagnostic }) {
  return <section className="render-readiness" aria-label="可渲染性诊断">
    <div className="render-readiness-head"><div><span>RENDER READINESS</span><strong>可渲染性诊断</strong></div><b>{diagnostic.failureNode.label}</b></div>
    <p className="render-readiness-cause">失败节点：<strong>{diagnostic.failureNode.detail}</strong></p>
    <div className="render-readiness-grid">
      <div><span>识别产品</span><strong>{diagnostic.productView.detectedProducts} 个</strong><small>{diagnostic.productView.empty ? "Product View 为空" : `已创建 ${diagnostic.productView.createdViews} 个 Product View`}</small></div>
      <div><span>Quality Gate</span><strong>Accept {diagnostic.qualityGate.accept} / Review {diagnostic.qualityGate.review} / Reject {diagnostic.qualityGate.reject}</strong><small>{diagnostic.qualityGate.status === "not_run" ? "尚未执行" : diagnostic.qualityGate.allRejected ? "全部未通过" : "已有可用镜头"}</small></div>
      <div><span>Scheduler</span><strong>{diagnostic.scheduler.status === "not_run" ? "未执行" : `失败 ${diagnostic.scheduler.failedProducts} 个产品`}</strong><small>{diagnostic.scheduler.status === "not_run" ? "未生成排片结果" : "见下方产品明细"}</small></div>
      <div><span>batch-edl.json</span><strong>{diagnostic.edl.exists ? `${diagnostic.edl.productsWritten} 个可渲染产品` : "未写入"}</strong><small>{diagnostic.edl.status === "blocked" ? "写入已阻止" : diagnostic.edl.status}</small></div>
    </div>
    <details className="render-readiness-products" open><summary>查看产品与 Slot 明细</summary><div>{diagnostic.products.map((product) => <article key={product.productId}><strong>{product.productId}</strong><span>素材 {product.sourceCount} · Accept Shot {product.acceptShots}</span><small>{product.schedule.status === "failed" ? `排片失败：缺少 ${product.schedule.missingSlot || "未知 Slot"}${product.schedule.reason ? `（${product.schedule.reason}）` : ""}` : product.schedule.status === "not_run" ? "Scheduler 未执行" : "排片成功"}</small>{product.excludedReason && <em>{product.excludedReason}</em>}</article>)}</div></details>
    {diagnostic.edl.blockedReason && <details className="render-readiness-reason"><summary>查看 EDL 阻止原因</summary><p>{diagnostic.edl.blockedReason}</p></details>}
  </section>;
}

function FailureDiagnosticsPanel({ diagnostics }: { diagnostics?: FailureDiagnosticsSnapshot }) {
  const latest = diagnostics?.latest;
  if (!latest) return null;
  const events = [...(diagnostics?.events || [])].reverse();
  return <section className="failure-diagnostics" aria-label="失败诊断">
    <div className="failure-diagnostics-head"><div><span>FAILURE DIAGNOSTICS</span><strong>失败定位信息</strong></div><time>{formatTime(latest.occurredAt)}</time></div>
    <div className="failure-diagnostics-grid">
      <div><span>Service</span><strong>{latest.service}</strong></div>
      <div><span>Stage</span><strong>{latest.stage}</strong></div>
      <div><span>Worker 实例</span><strong>{latest.workerInstance}</strong></div>
      <div><span>Exit Code</span><strong>{latest.exitCode ?? "未提供"}</strong></div>
      <div className="failure-diagnostics-wide"><span>Exception Message</span><strong>{latest.exceptionMessage}</strong></div>
      {latest.errorCode && <div><span>Error Code</span><strong>{latest.errorCode}</strong></div>}
      {latest.stderr && <div className="failure-diagnostics-wide"><span>stderr</span><pre>{latest.stderr}</pre></div>}
    </div>
    {latest.businessContext?.kind === "render_readiness" && <RenderReadinessPanel diagnostic={latest.businessContext} />}
    <details className="failure-log-details"><summary>查看详情</summary><div>{events.map((event) => <details className="failure-log-event" key={event.id} open={event.id === latest.id}><summary>{formatTime(event.occurredAt)} · {event.service} / {event.stage} · {event.workerInstance}</summary><pre>{event.fullLog}</pre></details>)}</div></details>
  </section>;
}

const defaultRequirements = `同一批素材使用同一脚本和同一剪辑结构。
成片控制在13秒以内，所有模特动作保持1.00×原速。
0–3秒用Hook抢停留；3–6秒建立穿搭兴趣；6秒以后展示正面、袖口、背面、面料等购买理由。
默认保持原视频颜色；只有手动选择时才复刻母版颜色或应用品牌 LUT。Hook位于顶部安全区，CVR参考样片的粗白字黑描边、表情和下指引导样式。`;
const newBatchDraftKey = "cutflow:new-batch-draft:v1";
const newBatchDraftLifetimeMs = 10 * 60 * 1000;
const defaultNasPath = "";
const defaultBatchName = "GC街头信仰服装 · 统一脚本";
const transitionProfileOptions: Array<{ value: TransitionProfile; label: string }> = [
  { value: "template", label: "Template · 严格复刻母版" },
  { value: "hard_cut", label: "Hard Cut · 全部硬切" },
  { value: "minimal", label: "Minimal · 仅结尾淡黑" },
  { value: "tiktok_fast", label: "TikTok Fast · 少量滑动/淡化" },
  { value: "fashion", label: "Fashion · 淡化/滑动" },
];
const transitionProfileLabel = (profile?: TransitionProfile) => transitionProfileOptions.find((item) => item.value === profile)?.label || "Template · 严格复刻母版";
const transitionModeLabel = (mode?: TransitionMode) => mode === "template_transition" ? "复刻母版转场" : mode === "standard" ? "普通自动剪辑" : "旧版转场策略";
const transitionTypeLabel = (type: string) => ({
  hard_cut: "Hard Cut",
  fade: "Fade",
  fadeblack: "Fade Black",
  dissolve: "Cross Dissolve",
  slideleft: "Slide Left",
  slideright: "Slide Right",
  wipeleft: "Wipe",
  wiperight: "Wipe",
  pixelize: "Pixelize",
}[type] || "Hard Cut");
const colorStrategyLabel = (strategy?: Batch["colorStrategy"]) => ({
  none: "保持原色视频",
  sample: "Template Color · 复刻母版颜色",
  lut: "Brand LUT · 品牌 LUT",
}[strategy || "none"]);

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

type NasScanView = NasScan & { preview: string[]; imagePreview?: string[] };
type NasDirectoryOption = { name: string; path: string };
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

function reviewEnteredAt(batch: Batch) {
  const outputTimes = batch.files
    .filter((file) => file.kind === "output")
    .map((file) => new Date(file.createdAt).getTime())
    .filter(Number.isFinite);
  return outputTimes.length ? new Date(Math.min(...outputTimes)).toISOString() : batch.updatedAt;
}

function reviewDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { key: "unknown", label: "日期未知" };
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "00";
  return { key: `${get("year")}-${get("month")}-${get("day")}`, label: `${get("year")}年${get("month")}月${get("day")}日` };
}

type DroppedEntry = {
  isFile: boolean;
  isDirectory: boolean;
  file?: (onSuccess: (file: File) => void, onError?: (error: DOMException) => void) => void;
  createReader?: () => { readEntries: (onSuccess: (entries: DroppedEntry[]) => void, onError?: (error: DOMException) => void) => void };
};

function acceptFile(file: File, accept?: string) {
  if (!accept) return true;
  // Folder drops from network shares can omit MIME metadata; keep those files and
  // let the existing server-side validation make the final format decision.
  if (!file.type) return true;
  return accept.split(",").map((value) => value.trim().toLowerCase()).some((rule) => {
    if (!rule) return false;
    if (rule.endsWith("/*")) return file.type.toLowerCase().startsWith(rule.slice(0, -1));
    if (rule.startsWith(".")) return file.name.toLowerCase().endsWith(rule);
    return file.type.toLowerCase() === rule;
  });
}

async function readDroppedEntry(entry: DroppedEntry): Promise<File[]> {
  if (entry.isFile && entry.file) {
    return new Promise((resolve) => entry.file?.((file) => resolve([file]), () => resolve([])));
  }
  if (!entry.isDirectory || !entry.createReader) return [];

  const reader = entry.createReader();
  const entries: DroppedEntry[] = [];
  while (true) {
    const next = await new Promise<DroppedEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!next.length) break;
    entries.push(...next);
  }
  return (await Promise.all(entries.map(readDroppedEntry))).flat();
}

async function filesFromDrop(event: DragEvent<HTMLElement>) {
  const items = Array.from(event.dataTransfer.items || []);
  const entries: DroppedEntry[] = [];
  for (const item of items) {
    const entry = (item as unknown as { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length) return (await Promise.all(entries.map(readDroppedEntry))).flat();
  return Array.from(event.dataTransfer.files || []);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const directoryProps = directory ? ({ webkitdirectory: "", directory: "" } as Record<string, string>) : {};
  const selectFiles = (next: File[]) => onChange(next.filter((file) => acceptFile(file, accept)));
  const dropFiles = async (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    selectFiles(await filesFromDrop(event));
  };
  const openPicker = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      inputRef.current?.click();
    }
  };
  return (
    <label
      className={`file-drop ${files.length ? "has-files" : ""} ${isDragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
      onDrop={dropFiles}
      onKeyDown={openPicker}
      tabIndex={0}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        {...directoryProps}
        onChange={(event: ChangeEvent<HTMLInputElement>) => selectFiles(Array.from(event.target.files ?? []))}
      />
      <span className="file-icon">{files.length ? "✓" : "+"}</span>
      <span className="file-copy">
        <strong>{files.length ? `${label} · ${files.length}个文件` : label}</strong>
        <small>{files.length ? files.slice(0, 2).map((file) => file.name).join("、") : hint}</small>
      </span>
      <span className="file-action">{isDragging ? "松开上传" : "选择或拖入"}</span>
    </label>
  );
}

function ProfilePanel({ profile }: { profile: ReferenceProfile }) {
  return (
    <div className="profile-panel">
      <div className="profile-head">
        <div>
          <span className="eyebrow">样片母版</span>
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

function TransitionSummary({ batch }: { batch: Batch }) {
  const transitions = batch.renderSummary?.transitions || [];
  const profile = batch.renderSummary?.transitionProfile || batch.transitionProfile;
  return <div className="transition-summary">
    <strong>剪辑模式：{transitionModeLabel(batch.transitionMode)}</strong>
    {batch.transitionMode === undefined && <small>历史任务，沿用原有转场策略：{transitionProfileLabel(profile)}</small>}
    <p>{transitions.length
      ? transitions.map((item) => transitionTypeLabel(item.type) + " " + (item.durationSeconds ? item.durationSeconds.toFixed(2) + "秒" : "硬切") + " × " + item.count).join(" · ")
      : "等待渲染后显示每种转场与时长。"}</p>
  </div>;
}

function ProductDetectionPanel({ detection, evidence = [] }: { detection: ProductDetection; evidence?: ProductGroupEvidence[] }) {
  const evidenceByGroup = new Map(evidence.map((item) => [item.groupId, item]));
  return (
    <div className="detection-panel">
      <div className="profile-head">
        <div><span className="eyebrow">产品识别</span><h3>自动识别到 {detection.groups.length} 款产品</h3></div>
        <div className="confidence">{Math.round(detection.confidence * 100)}% 总体置信度</div>
      </div>
      <p className="profile-summary">{detection.summary}</p>
      <div className="product-groups">
        {detection.groups.map((group, index) => {
          const groupEvidence = evidenceByGroup.get(group.id);
          return <div className={`product-group ${groupEvidence && (groupEvidence.videoThumbnailUrl || groupEvidence.productImageThumbnailUrl) ? "has-evidence" : ""}`} key={group.id}>
            <div className="group-number">{String(index + 1).padStart(2, "0")}</div>
            <div className="group-copy"><strong>{group.label}</strong><span>{group.signature}</span><small>{group.files.slice(0, 3).join(" · ")}{group.files.length > 3 ? ` 等${group.files.length}个视频` : ""}</small></div>
            <div className="group-score">{Math.round(group.confidence * 100)}%</div>
            {groupEvidence && (groupEvidence.videoThumbnailUrl || groupEvidence.productImageThumbnailUrl) && <div className="group-evidence" aria-label={`${group.label} 的分组证据`}>
              <div>{groupEvidence.videoThumbnailUrl ? <Image src={groupEvidence.videoThumbnailUrl} alt={`${group.label} 视频证据帧`} width={160} height={72} unoptimized /> : <span>暂无视频帧</span>}<small>视频帧</small></div>
              <div>{groupEvidence.productImageThumbnailUrl ? <Image src={groupEvidence.productImageThumbnailUrl} alt={`${group.label} 产品图`} width={160} height={72} unoptimized /> : <span>暂无产品图</span>}<small>产品图</small></div>
            </div>}
          </div>;
        })}
      </div>
      {!!detection.unassigned.length && <div className="unassigned">待人工确认：{detection.unassigned.join("、")}</div>}
    </div>
  );
}

function LoginPanel({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: string };
      if (!response.ok || !payload.user) throw new Error(payload.error || "Unable to sign in");
      onAuthenticated(payload.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="login-shell">
    <form className="login-card" onSubmit={submit}>
      <div className="login-brand"><span>GC</span><div><strong>Cutflow</strong><small>Private workspace sign in</small></div></div>
      <h1>Sign in to your workspace</h1>
      <p>Tasks, source files, reviews, and outputs are available only to the signed-in account.</p>
      <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
      <label><span>Password</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
      {error && <div className="login-error" role="alert">{error}</div>}
      <button className="primary-button" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</button>
    </form>
  </main>;
}

export default function Home() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<AppView>("dashboard");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [templates, setTemplates] = useState<SampleTemplate[]>([]);
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [error, setError] = useState("");
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userCreatePending, setUserCreatePending] = useState(false);
  const [userCreateError, setUserCreateError] = useState("");
  const [newUser, setNewUser] = useState<NewUserDraft>({ username: "", role: "member" });
  const [newUserPasswordVisible, setNewUserPasswordVisible] = useState(false);
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [resetPasswordNotice, setResetPasswordNotice] = useState<{ id: string; password: string } | null>(null);
  const [workerOnline, setWorkerOnline] = useState(false);
  const [, setTick] = useState(0);
  const draftStorageKey = authUser ? `${newBatchDraftKey}:${authUser.id}` : newBatchDraftKey;
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { user?: AuthUser } : {})
      .then((payload) => { if (active) setAuthUser(payload.user || null); })
      .catch(() => { if (active) setAuthUser(null); })
      .finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
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
  const [nasPath, setNasPath] = useState(defaultNasPath);
  const [nasScan, setNasScan] = useState<NasScanView | null>(null);
  const [scanningNas, setScanningNas] = useState(false);
  const [nasRootPath, setNasRootPath] = useState("");
  const [nasDirectories, setNasDirectories] = useState<NasDirectoryOption[]>([]);
  const [nasDirectoriesLoading, setNasDirectoriesLoading] = useState(false);
  const [nasDirectoriesError, setNasDirectoriesError] = useState("");

  const [batchName, setBatchName] = useState(defaultBatchName);
  const [requirements, setRequirements] = useState(defaultRequirements);
  const [durationMax, setDurationMax] = useState(13);
  const [outputCount, setOutputCount] = useState(1);
  const [cvrText, setCvrText] = useState("");
  const [hookText, setHookText] = useState("");
  const [cvrOverrideEnabled, setCvrOverrideEnabled] = useState(false);
  const [hookOverrideEnabled, setHookOverrideEnabled] = useState(false);
  const [colorStrategy, setColorStrategy] = useState<"none" | "sample" | "lut">("none");
  const [musicSource, setMusicSource] = useState<"template" | "library" | "upload">("template");
  const [transitionMode, setTransitionMode] = useState<TransitionMode>("standard");
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [productFiles, setProductFiles] = useState<File[]>([]);
  const [productReferenceFiles, setProductReferenceFiles] = useState<File[]>([]);
  const [lutFiles, setLutFiles] = useState<File[]>([]);
  const [hookFiles, setHookFiles] = useState<File[]>([]);
  const [bgmFiles, setBgmFiles] = useState<File[]>([]);
  const [revision, setRevision] = useState("");
  const [revisionPending, setRevisionPending] = useState(false);
  const [groupCommand, setGroupCommand] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("街头服装 13秒母版");
  const [templateFiles, setTemplateFiles] = useState<File[]>([]);
  const [templateSubmitting, setTemplateSubmitting] = useState(false);
  const [templateUploadState, setTemplateUploadState] = useState("");
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>({});
  const [recoveryByBatch, setRecoveryByBatch] = useState<Record<string, RecoverySnapshot>>({});
  const [diagnosticsByBatch, setDiagnosticsByBatch] = useState<Record<string, FailureDiagnosticsSnapshot>>({});
  const [artifactEvidenceByBatch, setArtifactEvidenceByBatch] = useState<Record<string, ArtifactEvidenceSnapshot | null>>({});
  const [productGroupEvidenceByBatch, setProductGroupEvidenceByBatch] = useState<Record<string, ProductGroupEvidence[]>>({});
  const [artifactReviewPending, setArtifactReviewPending] = useState<string | null>(null);

  const loadBatches = useCallback(async () => {
    if (!authUser) {
      setLoading(false);
      return;
    }
    try {
      const [batchResponse, healthResponse, templateResponse, dashboardResponse] = await Promise.all([
        fetch("/api/batches", { cache: "no-store" }),
        fetch("/api/health", { cache: "no-store" }),
        fetch("/api/templates", { cache: "no-store" }),
        fetch("/api/dashboard", { cache: "no-store" }),
      ]);
      if ([batchResponse, healthResponse, templateResponse, dashboardResponse].some((response) => response.status === 401)) {
        setAuthUser(null);
        return;
      }
      if (batchResponse.ok) {
        const data = (await batchResponse.json()) as { batches: Batch[] };
        setBatches(data.batches);
        // 工作台不自动打开某个任务；只有用户明确点击任务或新建批次后才进入批次工作区。
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
      if (dashboardResponse.ok) setDashboard((await dashboardResponse.json()) as DashboardSnapshot);
    } finally {
      setLoading(false);
    }
  }, [authUser]);

  const loadManagedUsers = useCallback(async () => {
    if (authUser?.role !== "admin") {
      setManagedUsers([]);
      return;
    }
    setUsersLoading(true);
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { users?: ManagedUser[]; error?: string };
      if (response.status === 401) {
        setAuthUser(null);
        return;
      }
      if (!response.ok) throw new Error(payload.error || "无法读取用户列表");
      setManagedUsers(Array.isArray(payload.users) ? payload.users : []);
    } catch (caught) {
      setUserCreateError(caught instanceof Error ? caught.message : "无法读取用户列表");
    } finally {
      setUsersLoading(false);
    }
  }, [authUser]);

  const loadNasDirectories = useCallback(async () => {
    setNasDirectoriesLoading(true);
    setNasDirectoriesError("");
    try {
      const response = await fetch("/api/nas/directories", { cache: "no-store" });
      const payload = await response.json() as { rootPath?: string; directories?: NasDirectoryOption[]; error?: string };
      if (!response.ok || !payload.rootPath || !Array.isArray(payload.directories)) throw new Error(payload.error || "无法读取 NAS 素材目录");
      setNasRootPath(payload.rootPath);
      setNasDirectories(payload.directories);
      setNasPath((current) => payload.directories?.some((directory) => directory.path === current) ? current : "");
      setNasScan((current) => current && payload.directories?.some((directory) => directory.path === current.rootPath) ? current : null);
    } catch (caught) {
      setNasDirectories([]);
      setNasScan(null);
      setNasDirectoriesError(caught instanceof Error ? caught.message : "无法读取 NAS 素材目录");
    } finally {
      setNasDirectoriesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authUser) return;
    const initialLoad = window.setTimeout(() => { void loadBatches(); }, 0);
    const timer = window.setInterval(loadBatches, 3500);
    return () => { window.clearTimeout(initialLoad); window.clearInterval(timer); };
  }, [authUser, loadBatches]);

  useEffect(() => {
    if (view !== "users" || authUser?.role !== "admin") return;
    const requestId = window.setTimeout(() => { void loadManagedUsers(); }, 0);
    return () => window.clearTimeout(requestId);
  }, [authUser, loadManagedUsers, view]);

  useEffect(() => {
    if (!authUser || view !== "new-batch" || sourceMode !== "nas") return;
    const requestId = window.setTimeout(() => { void loadNasDirectories(); }, 0);
    return () => window.clearTimeout(requestId);
  }, [authUser, view, sourceMode, loadNasDirectories]);

  useEffect(() => {
    if (view !== "new-batch") return;
    const persistDraft = () => {
      const expiresAt = Date.now() + newBatchDraftLifetimeMs;
      const draft: NewBatchDraft = { batchName, requirements, durationMax, outputCount, cvrText, hookText, cvrOverrideEnabled, hookOverrideEnabled, sourceMode, nasPath, selectedTemplateId, colorStrategy, musicSource, transitionMode, expiresAt };
      window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
    };
    window.addEventListener("pagehide", persistDraft);
    return () => window.removeEventListener("pagehide", persistDraft);
  }, [view, batchName, requirements, durationMax, outputCount, cvrText, hookText, cvrOverrideEnabled, hookOverrideEnabled, sourceMode, nasPath, selectedTemplateId, colorStrategy, musicSource, transitionMode, draftStorageKey]);

  useEffect(() => {
    const ids = authUser && selectedId ? [selectedId] : [];
    if (!ids.length) return;
    let active = true;
    Promise.all(ids.map(async (id) => {
      const [recoveryResponse, diagnosticsResponse, artifactResponse, groupEvidenceResponse] = await Promise.all([
        fetch(`/api/batches/${id}/recovery`, { cache: "no-store" }),
        fetch(`/api/batches/${id}/diagnostics`, { cache: "no-store" }),
        fetch(`/api/batches/${id}/artifact-review`, { cache: "no-store" }),
        fetch(`/api/batches/${id}/group-evidence`, { cache: "no-store" }),
      ]);
      const recoveryPayload = recoveryResponse.ok ? await recoveryResponse.json() as { recovery?: RecoverySnapshot } : {};
      const diagnosticsPayload = diagnosticsResponse.ok ? await diagnosticsResponse.json() as { diagnostics?: FailureDiagnosticsSnapshot } : {};
      const artifactPayload = artifactResponse.ok ? await artifactResponse.json() as { evidence?: ArtifactEvidenceSnapshot | null } : {};
      const groupEvidencePayload = groupEvidenceResponse.ok ? await groupEvidenceResponse.json() as ProductGroupEvidenceSnapshot : {};
      return [id, recoveryPayload.recovery || null, diagnosticsPayload.diagnostics || null, artifactPayload.evidence || null, groupEvidencePayload.groups || []] as const;
    })).then((results) => {
      if (!active) return;
      setRecoveryByBatch((current) => {
        const next = { ...current };
        for (const [id, recovery] of results) if (recovery) next[id] = recovery;
        return next;
      });
      setDiagnosticsByBatch((current) => {
        const next = { ...current };
        for (const [id, , diagnostics] of results) if (diagnostics) next[id] = diagnostics;
        return next;
      });
      setArtifactEvidenceByBatch((current) => {
        const next = { ...current };
        for (const [id, , , evidence] of results) next[id] = evidence;
        return next;
      });
      setProductGroupEvidenceByBatch((current) => {
        const next = { ...current };
        for (const [id, , , , evidence] of results) next[id] = evidence;
        return next;
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [authUser, selectedId]);

  const selected = useMemo(() => batches.find((batch) => batch.id === selectedId) ?? null, [batches, selectedId]);
  const selectedTemplate = useMemo(() => templates.find((item) => item.id === selectedTemplateId) ?? null, [templates, selectedTemplateId]);
  const reviewBatches = useMemo(() => batches.filter((batch) => ["review", "completed"].includes(batch.status) && batch.files.some((file) => file.kind === "output")), [batches]);
  const reviewBatchGroups = useMemo(() => {
    const groups = new Map<string, { label: string; batches: Batch[] }>();
    for (const batch of [...reviewBatches].sort((left, right) => reviewEnteredAt(right).localeCompare(reviewEnteredAt(left)))) {
      const day = reviewDay(reviewEnteredAt(batch));
      const group = groups.get(day.key) || { label: day.label, batches: [] };
      group.batches.push(batch);
      groups.set(day.key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
  }, [reviewBatches]);
  const completedCount = reviewBatches.length;
  const activeCount = batches.filter((batch) => ["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising", "cancel_requested"].includes(batch.status)).length;
  const taskNavigationActive = ["batches", "new-batch", "batch-detail"].includes(view);
  const pageTitle = view === "dashboard" ? "工作台" : view === "batches" ? "任务" : view === "new-batch" ? "新建任务" : view === "batch-detail" ? "任务详情" : view === "templates" ? "样片母版库" : "成片审核";
  const pageDescription = view === "dashboard" ? "先看今天待处理、待审核与异常任务；从这里继续任务或新建批次。" : view === "batches" ? "查看全部剪辑任务；打开一条任务后，只显示该任务的执行信息。" : view === "new-batch" ? "选择母版、接入素材，然后创建一条新的剪辑任务。" : view === "batch-detail" ? "查看当前任务的素材、执行进度、识别结果与后续操作。" : view === "templates" ? "公共样片母版库：所有已登录账号都可查看、预览和选用；上传与重新分析仅由创建者管理。" : "逐条预览成片，确认通过后自动交付到成片目录。";

  const displayedPageTitle = view === "users" ? "用户管理" : pageTitle;
  const displayedPageDescription = view === "users" ? "仅管理员可创建账号并查看工作区用户。" : pageDescription;

  function clearNewBatchDraft() {
    window.localStorage.removeItem(draftStorageKey);
  }

  function resetNewBatchForm() {
    setBatchName(defaultBatchName);
    setRequirements(defaultRequirements);
    setDurationMax(13);
    setOutputCount(1);
    setCvrText("");
    setHookText("");
    setCvrOverrideEnabled(false);
    setHookOverrideEnabled(false);
    setSourceMode("nas");
    setNasPath(defaultNasPath);
    setNasScan(null);
    setSelectedTemplateId(templates.find((item) => item.status === "ready")?.id || "");
    setColorStrategy("none");
    setMusicSource("template");
    setTransitionMode("standard");
    setReferenceFiles([]);
    setProductFiles([]);
    setProductReferenceFiles([]);
    setLutFiles([]);
    setHookFiles([]);
    setBgmFiles([]);
  }

  function cacheNewBatchDraft() {
    const expiresAt = Date.now() + newBatchDraftLifetimeMs;
    const draft: NewBatchDraft = { batchName, requirements, durationMax, outputCount, cvrText, hookText, cvrOverrideEnabled, hookOverrideEnabled, sourceMode, nasPath, selectedTemplateId, colorStrategy, musicSource, transitionMode, expiresAt };
    window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
    window.setTimeout(() => {
      try {
        const cached = JSON.parse(window.localStorage.getItem(draftStorageKey) || "null") as Partial<NewBatchDraft> | null;
        if (cached?.expiresAt && cached.expiresAt <= Date.now()) clearNewBatchDraft();
      } catch {
        clearNewBatchDraft();
      }
    }, newBatchDraftLifetimeMs);
  }

  function restoreNewBatchDraft() {
    try {
      const draft = JSON.parse(window.localStorage.getItem(draftStorageKey) || "null") as Partial<NewBatchDraft> | null;
      if (!draft || typeof draft.expiresAt !== "number" || draft.expiresAt <= Date.now()) {
        clearNewBatchDraft();
        resetNewBatchForm();
        return;
      }
      if (typeof draft.batchName === "string") setBatchName(draft.batchName);
      if (typeof draft.requirements === "string") setRequirements(draft.requirements);
      if (typeof draft.durationMax === "number") setDurationMax(draft.durationMax);
      if (typeof draft.outputCount === "number") setOutputCount(draft.outputCount);
      if (typeof draft.cvrText === "string") setCvrText(draft.cvrText);
      if (typeof draft.hookText === "string") setHookText(draft.hookText);
      if (typeof draft.cvrOverrideEnabled === "boolean") setCvrOverrideEnabled(draft.cvrOverrideEnabled);
      if (typeof draft.hookOverrideEnabled === "boolean") setHookOverrideEnabled(draft.hookOverrideEnabled);
      if (draft.sourceMode === "nas" || draft.sourceMode === "upload") setSourceMode(draft.sourceMode);
      if (typeof draft.nasPath === "string") setNasPath(draft.nasPath);
      if (typeof draft.selectedTemplateId === "string") setSelectedTemplateId(draft.selectedTemplateId);
      if (draft.colorStrategy === "none" || draft.colorStrategy === "sample" || draft.colorStrategy === "lut") setColorStrategy(draft.colorStrategy);
      if (draft.musicSource === "template" || draft.musicSource === "library" || draft.musicSource === "upload") setMusicSource(draft.musicSource);
      if (draft.transitionMode === "standard" || draft.transitionMode === "template_transition") setTransitionMode(draft.transitionMode);
    } catch {
      clearNewBatchDraft();
      resetNewBatchForm();
    }
  }

  function navigateTo(nextView: AppView) {
    if (nextView === "users" && authUser?.role !== "admin") return;
    if (view === "new-batch" && nextView !== "new-batch") cacheNewBatchDraft();
    setView(nextView);
  }

  function openUserManagement() {
    if (authUser?.role !== "admin") return;
    setError("");
    setUserCreateError("");
    navigateTo("users");
  }

  async function createManagedUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authUser?.role !== "admin") return;
    setUserCreatePending(true);
    setUserCreateError("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(newUser),
      });
      const payload = await response.json().catch(() => ({})) as { user?: ManagedUser; error?: string };
      if (response.status === 401) {
        setAuthUser(null);
        return;
      }
      if (!response.ok || !payload.user) throw new Error(payload.error || "创建账号失败");
      setNewUser({ username: "", role: "member" });
      setNewUserPasswordVisible(false);
      await loadManagedUsers();
    } catch (caught) {
      setUserCreateError(caught instanceof Error ? caught.message : "创建账号失败");
    } finally {
      setUserCreatePending(false);
    }
  }

  async function resetManagedUserPassword(user: ManagedUser) {
    if (authUser?.role !== "admin") return;
    if (!window.confirm(`确定将“${user.username}”的密码重置为初始密码 ${user.username.toLowerCase()}123456 吗？该账号当前的登录会话会失效。`)) return;
    setResettingUserId(user.id);
    setUserCreateError("");
    try {
      const response = await fetch(`/api/admin/users/${user.id}/reset-password`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { initialPassword?: string; error?: string };
      if (!response.ok || !payload.initialPassword) throw new Error(payload.error || "重置密码失败");
      setResetPasswordNotice({ id: user.id, password: payload.initialPassword });
    } catch (caught) {
      setUserCreateError(caught instanceof Error ? caught.message : "重置密码失败");
    } finally {
      setResettingUserId(null);
    }
  }

  function openBatchWorkspace(batchId?: string) {
    if (batchId) {
      setSelectedId(batchId);
      navigateTo("batch-detail");
      return;
    }
    setSelectedId(null);
    navigateTo("batches");
  }

  function openNewBatch() {
    setSelectedId(null);
    setError("");
    restoreNewBatchDraft();
    setView("new-batch");
  }

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

  async function decideArtifactReview(batchId: string, sourceKey: string, decision: "accept" | "reject") {
    setError("");
    setArtifactReviewPending(`${batchId}:${sourceKey}`);
    try {
      const response = await fetch(`/api/batches/${batchId}/artifact-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKey, decision }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Artifact 审核操作失败");
      setArtifactEvidenceByBatch((current) => ({ ...current, [batchId]: payload.evidence || current[batchId] || null }));
      await loadBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Artifact 审核操作失败");
    } finally {
      setArtifactReviewPending(null);
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
    if (!nasPath) {
      setError("请先从指定 NAS 素材根目录中选择一个批次文件夹。");
      return;
    }
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
    if (musicSource === "upload" && !bgmFiles.length) return setError("请选择至少一条本批 BGM，或改用母版 BGM / BGM库。");
    setSubmitting(true);
    try {
      const response = await fetch("/api/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchName, requirements, durationMax, outputCount, cvrText: cvrOverrideEnabled ? cvrText : undefined, hookText: hookOverrideEnabled ? hookText : undefined, colorStrategy, musicSource, transitionMode, speed: 1, sourceMode, nasPath: sourceMode === "nas" ? nasPath : undefined, templateId: selectedTemplateId || undefined }),
      });
      const payload = (await response.json()) as { batch?: Batch; error?: string };
      if (!response.ok || !payload.batch) throw new Error(payload.error || "创建批次失败");
      const batch = payload.batch;
      setSelectedId(batch.id);
      const groups = [
        ["reference", selectedTemplateId ? [] : referenceFiles],
        ["products", sourceMode === "upload" ? productFiles : []],
        ["product_refs", productReferenceFiles],
        ["lut", colorStrategy === "none" ? [] : lutFiles],
        ["hooks", hookOverrideEnabled ? hookFiles : []],
        ["bgm", musicSource === "upload" ? bgmFiles : []],
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
      clearNewBatchDraft();
      setView("batch-detail");
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
    setError("");
    setRevisionPending(true);
    try {
      const response = await fetch(`/api/batches/${selected.id}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: revision.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `提交修改失败 (HTTP ${response.status})`);
      setRevision("");
      await loadBatches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交修改失败，请稍后重试");
    } finally {
      setRevisionPending(false);
    }
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
    if (!templateFiles.length) return setError("请先选择至少一条参考样片。");
    setTemplateSubmitting(true);
    setTemplateUploadState("");
    const failures: string[] = [];
    let queued = 0;
    try {
      for (const [index, file] of templateFiles.entries()) {
        const baseName = file.name.replace(/\.[^.]+$/, "").trim() || `样片${index + 1}`;
        const name = templateFiles.length === 1 ? templateName.trim() : `${templateName.trim() || "样片母版"} · ${baseName}`;
        setTemplateUploadState(`正在提交第 ${index + 1}/${templateFiles.length} 条样片：${file.name}`);
        try {
          const createResponse = await fetch("/api/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
          const created = await createResponse.json();
          if (!createResponse.ok || !created.template) throw new Error(created.error || "创建母版失败");
          const uploadResponse = await fetch("/api/template-uploads", { method: "POST", headers: { "x-template-id": created.template.id, "x-file-name": encodeURIComponent(file.name) }, body: file });
          if (!uploadResponse.ok) throw new Error((await uploadResponse.json()).error || "样片上传失败");
          const queueResponse = await fetch(`/api/templates/${created.template.id}/queue`, { method: "POST" });
          if (!queueResponse.ok) throw new Error((await queueResponse.json()).error || "母版分析入队失败");
          queued += 1;
        } catch (caught) {
          failures.push(`${file.name}：${caught instanceof Error ? caught.message : "提交失败"}`);
        }
      }
      setTemplateFiles([]);
      await loadBatches();
      if (failures.length) setError(`已入队 ${queued}/${templateFiles.length} 条样片；${failures.join("；")}`);
      else setTemplateUploadState(`已将 ${queued} 条样片加入拆解队列，可继续上传或创建剪辑批次。`);
    } finally {
      setTemplateSubmitting(false);
    }
  }

  async function saveOutput(batchId: string, file: { id: string; name: string }) {
    const url = `/api/batches/${batchId}/media/${file.id}?download=1`;
    const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
    if (!picker) {
      window.location.assign(url);
      return;
    }
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to retrieve the selected output");
      const handle = await picker({ suggestedName: file.name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
      const writable = await handle.createWritable();
      await writable.write(await response.blob());
      await writable.close();
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Unable to save the selected output");
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthUser(null);
    setBatches([]);
    setTemplates([]);
    setDashboard(null);
    setSelectedId(null);
    setView("dashboard");
  }

  if (authLoading) return <main className="login-shell"><div className="login-card"><div className="login-brand"><span>GC</span><div><strong>Cutflow</strong><small>Loading private workspace…</small></div></div></div></main>;
  if (!authUser) return <LoginPanel onAuthenticated={(user) => { setAuthUser(user); setLoading(true); }} />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>GC</span><div><strong>Cutflow</strong><small>统一剪辑工作台</small></div></div>
        <nav aria-label="主要导航">
          <button className={`nav-item ${view === "dashboard" ? "active" : ""}`} onClick={() => navigateTo("dashboard")}><span>◌</span>工作台<i>•</i></button>
          <button className={`nav-item ${taskNavigationActive ? "active" : ""}`} onClick={() => openBatchWorkspace()}><span>▦</span>任务<i>{batches.length}</i></button>
          <button className={`nav-item ${view === "templates" ? "active" : ""}`} onClick={() => navigateTo("templates")}><span>◫</span>样片母版<i>{templates.filter((item) => item.status === "ready").length}</i></button>
          <button className={`nav-item ${view === "reviews" ? "active" : ""}`} onClick={() => navigateTo("reviews")}><span>✓</span>成片审核<i>{completedCount}</i></button>
        </nav>
        {authUser.role === "admin" && <button className={`admin-user-management ${view === "users" ? "active" : ""}`} onClick={openUserManagement}><span>⚙</span>用户管理</button>}
        {view !== "dashboard" && <div className="sidebar-note">
          <span className={`status-dot ${workerOnline ? "online" : ""}`} />
          <div><strong>{workerOnline ? "剪辑工作机在线" : "剪辑工作机未连接"}</strong><small>{workerOnline ? "任务会自动处理" : "启动本地Worker后自动接单"}</small></div>
        </div>}
        <div className="user-card"><span>{authUser.displayName.slice(0, 2).toUpperCase()}</span><div><strong>{authUser.displayName}</strong><small>{authUser.role === "admin" ? "Administrator · private workspace" : "Private workspace"}</small></div><button className="user-signout" onClick={signOut}>Sign out</button></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-copy"><span className="eyebrow">广告创意工作台</span><h1>{displayedPageTitle}</h1><p>{displayedPageDescription}</p></div>
          <div className="topbar-actions">
            {view !== "new-batch" && <button className="primary-button new-task-button" onClick={openNewBatch}>＋ 新建任务</button>}
            {view !== "dashboard" && <div className="top-stats"><div><strong>{activeCount}</strong><span>处理中</span></div><div><strong>{completedCount}</strong><span>待审核/完成</span></div></div>}
          </div>
        </header>

        {view !== "dashboard" && !loading && (!workerOnline || !accountState.codex?.ready) && (
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

        {view !== "dashboard" && !loading && workerOnline && accountState.codex?.ready && !accountState.chatcut?.ready && (
          <div className="safe-mode-banner chatcut-only">
            <span className="safe-mode-icon">i</span>
            <div>
              <strong>自动剪辑正常；ChatCut 待连接</strong>
              <small>MP4 成片会正常生成，仅“可编辑项目链接”暂时不会创建。</small>
            </div>
            <small className="safe-mode-action">无需暂停当前任务</small>
          </div>
        )}

        {view === "users" && authUser.role === "admin" ? (
          <section className="user-management-page" aria-labelledby="user-management-title">
            <div className="user-management-head">
              <div><span className="eyebrow">ADMIN ONLY</span><h2 id="user-management-title">用户管理</h2><p>创建工作区账号，并查看当前账号权限。</p></div>
              <button className="secondary-button" type="button" onClick={() => void loadManagedUsers()} disabled={usersLoading}>{usersLoading ? "刷新中…" : "刷新列表"}</button>
            </div>
            <div className="user-management-grid">
              <form className="user-create-card" onSubmit={createManagedUser}>
                <div><span className="eyebrow">NEW ACCOUNT</span><h3>创建账号</h3><p>初始密码固定为“用户名 + 123456”；点击眼睛可显示或隐藏。</p></div>
                <label><span>用户名</span><input value={newUser.username} onChange={(event) => setNewUser((current) => ({ ...current, username: event.target.value }))} autoComplete="username" pattern="[A-Za-z0-9._-]{3,64}" title="使用 3–64 位字母、数字、点、下划线或连字符" maxLength={64} required /></label>
                <label><span>初始密码</span><span className="password-input-wrap"><input value={newUser.username.trim() ? `${newUser.username.trim().toLowerCase()}123456` : "用户名123456"} type={newUserPasswordVisible ? "text" : "password"} autoComplete="new-password" readOnly /><button className="password-visibility-toggle" type="button" onClick={() => setNewUserPasswordVisible((visible) => !visible)} aria-label={newUserPasswordVisible ? "隐藏初始密码" : "显示初始密码"} title={newUserPasswordVisible ? "隐藏密码" : "显示密码"}>{newUserPasswordVisible ? "◉" : "◌"}</button></span></label>
                <label><span>权限</span><select value={newUser.role} onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value as NewUserDraft["role"] }))}><option value="member">普通成员</option><option value="admin">管理员</option></select></label>
                {userCreateError && <div className="user-management-error" role="alert">{userCreateError}</div>}
                <button className="primary-button" disabled={userCreatePending}>{userCreatePending ? "创建中…" : "创建账号"}</button>
              </form>
              <section className="user-list-card" aria-live="polite">
                <div className="user-list-head"><div><span className="eyebrow">WORKSPACE USERS</span><h3>已有账号</h3></div><strong>{managedUsers.length}</strong></div>
                {usersLoading ? <div className="user-list-empty">正在读取账号列表…</div> : !managedUsers.length ? <div className="user-list-empty">尚未找到账号。</div> : <div className="user-list">
                  {managedUsers.map((user) => <article className="managed-user-row" key={user.id}>
                    <div><strong>{user.username}</strong><small>创建于 {new Date(user.createdAt).toLocaleDateString("zh-CN")}</small>{resetPasswordNotice?.id === user.id && <em className="password-reset-notice">已重置为初始密码：{resetPasswordNotice.password}</em>}</div>
                    <div className="managed-user-badges"><button className="reset-password-button" type="button" onClick={() => void resetManagedUserPassword(user)} disabled={resettingUserId === user.id}>{resettingUserId === user.id ? "重置中…" : "重置密码"}</button><span className={`user-role ${user.role}`}>{user.role === "admin" ? "管理员" : "成员"}</span><span className={`user-status ${user.status}`}>{user.status === "active" ? "启用" : "已停用"}</span></div>
                  </article>)}
                </div>}
              </section>
            </div>
          </section>
        ) : view === "dashboard" ? <DashboardOverview data={dashboard} loading={loading} onRefresh={loadBatches} onOpenBatch={openBatchWorkspace} onCreateBatch={openNewBatch} /> : view === "batches" ? (
          <section className="task-list-page">
            <div className="task-list-card">
              <div className="section-head task-list-head"><div><span className="eyebrow">全部任务</span><h2>任务列表</h2></div><button className="icon-button" onClick={loadBatches} aria-label="刷新任务">↻</button></div>
              <div className="task-list-table" role="table">
                <div className="task-list-row header" role="row"><span>任务名称</span><span>状态</span><span>当前阶段</span><span>素材</span><span>最近更新</span><span>操作</span></div>
                {loading && <div className="empty-state">正在读取任务…</div>}
                {!loading && !batches.length && <div className="empty-state"><strong>还没有任务</strong><span>使用右上角的新建任务开始第一批剪辑。</span></div>}
                {!loading && batches.map((batch) => {
                  const meta = statusMeta[batch.status];
                  const current = lifecycleCurrent(batch);
                  return <button className="task-list-row" role="row" key={batch.id} onClick={() => openBatchWorkspace(batch.id)}>
                    <strong>{batch.name}</strong>
                    <span><i className={`status-badge ${batch.status}`} />{meta.label}</span>
                    <span title={current.detail}>{current.label}</span>
                    <span>{batch.files.filter((file) => file.kind === "products").length} 个文件</span>
                    <time>{timeAgo(batch.updatedAt)}</time>
                    <b>查看详情 →</b>
                  </button>;
                })}
              </div>
            </div>
          </section>
        ) : (view === "new-batch" || view === "batch-detail") ? (<>
        {view === "new-batch" && <div className="new-batch-layout">
          <section className="creation-card">
            <div className="section-head"><div><span className="step-badge">新建</span><h2>创建剪辑批次</h2></div><div className="new-batch-head-actions"><span className="speed-lock">动作固定 1.00×</span><button className="back-button" type="button" onClick={() => openBatchWorkspace()}>← 任务列表</button></div></div>
            <div className="stepper"><div className="on"><b>1</b><span>选择母版</span></div><i/><div className="on"><b>2</b><span>连接素材</span></div><i/><div className="on"><b>3</b><span>自动分产品</span></div><i/><div><b>4</b><span>确认分组</span></div></div>

            <form onSubmit={createBatch}>
              <div className="field-row two">
                <label><span>批次名称</span><input value={batchName} onChange={(event) => setBatchName(event.target.value)} required /></label>
                <div className="copy-override"><span>CVR文案</span><div className="copy-override-control"><input value={cvrOverrideEnabled ? cvrText : "与样片一致"} onChange={(event) => setCvrText(event.target.value)} placeholder="输入新的 CVR 文案" disabled={!cvrOverrideEnabled} /><button type="button" className="text-button" onClick={() => { setCvrOverrideEnabled((current) => !current); if (cvrOverrideEnabled) setCvrText(""); }}>{cvrOverrideEnabled ? "恢复样片" : "编辑"}</button></div></div>
              </div>

              <div className="upload-grid source-grid">
                <div className="template-source-card">
                  <label><span>样片母版</span><select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">临时上传新样片</option>{templates.filter((item) => item.status === "ready").map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                  {selectedTemplateId ? <div className="template-ready"><span>✓</span><div><strong>结构母版已就绪</strong><small>{selectedTemplate?.profile?.summary || "提交后跳过样片识别"}</small></div></div> : <FileDrop label="上传临时样片" hint="建议先到样片母版页提前拆解" files={referenceFiles} accept="video/*" onChange={(files) => setReferenceFiles(files.slice(0, 1))} />}
                </div>
                <div className="source-picker">
                  <div className="source-tabs" role="tablist" aria-label="原片接入方式">
                    <button type="button" className={sourceMode === "nas" ? "active" : ""} onClick={() => setSourceMode("nas")}>NAS直读 <b>推荐</b></button>
                    <button type="button" className={sourceMode === "upload" ? "active" : ""} onClick={() => setSourceMode("upload")}>浏览器上传</button>
                  </div>
                  {sourceMode === "nas" ? (
                    <div className="nas-source">
                      <p className="nas-root-note">固定素材根目录：<code>{nasRootPath || "正在读取…"}</code></p>
                      <div className="nas-input"><select value={nasPath} onChange={(event) => { setNasPath(event.target.value); setNasScan(null); }} disabled={nasDirectoriesLoading || Boolean(nasDirectoriesError)} aria-label="选择 NAS 批次文件夹"><option value="">{nasDirectoriesLoading ? "正在读取可用文件夹…" : "请选择一个批次文件夹"}</option>{nasDirectories.map((directory) => <option key={directory.path} value={directory.path}>{directory.name}</option>)}</select><button type="button" onClick={scanNasDirectory} disabled={scanningNas || nasDirectoriesLoading || !nasPath}>{scanningNas ? "检查中…" : "检查并扫描"}</button></div>
                      {nasDirectoriesError ? <div className="nas-directory-error"><span>!</span><div><strong>无法读取 NAS 文件夹</strong><small>{nasDirectoriesError}</small></div><button type="button" onClick={() => void loadNasDirectories()} disabled={nasDirectoriesLoading}>重试</button></div> : nasScan ? <div className="nas-result"><span>✓</span><div><strong>目录可读 · {nasScan.fileCount} 个视频 · {nasScan.imageCount || 0} 张产品图 · {formatSize(nasScan.totalSize)}</strong><small>{nasScan.speedMBps ? `实测读取约 ${nasScan.speedMBps} MB/s · ` : ""}视频和产品图均留在 NAS，仅在本机建立分析索引</small></div></div> : <p>仅显示固定根目录下的一级批次文件夹；选择后才会扫描该批次的媒体文件。</p>}
                    </div>
                  ) : <FileDrop label="选择本次拍摄全部视频" hint="备用方式：视频将逐个上传到剪辑工作机" files={productFiles} accept="video/*" multiple directory onChange={setProductFiles} />}
                </div>
              </div>

              <div className="product-reference-row">
                <div className="product-reference-copy"><span>可选增强</span><strong>产品参考图</strong><small>上传商品图、平铺图或SKU图，帮助正面、背面和细节视频准确归入同一款。NAS目录里的图片会自动读取。</small></div>
                <FileDrop label="补充产品图文件夹" hint="JPG / PNG / WebP，可一次选择整文件夹" files={productReferenceFiles} accept="image/*" multiple directory onChange={setProductReferenceFiles} />
              </div>

              <div className="auto-detect-banner"><span>编号</span><div><strong>文件名优先分组已开启</strong><small>系统先按产品编号分组；同产品只出现一个模特时合并为产品 Session，出现多个命名模特时自动拆分。无法解析产品编号时才使用视觉识别兜底。</small></div><b>固定开启</b></div>

              <label className="full-field"><span>全批次统一脚本与要求</span><textarea value={requirements} onChange={(event) => setRequirements(event.target.value)} rows={6} /></label>

              <div className="field-row settings">
                <label><span>最长时长</span><div className="unit-input"><input type="number" min="6" max="30" value={durationMax} onChange={(event) => setDurationMax(Number(event.target.value))} /><em>秒</em></div></label>
                <label><span>每款输出</span><div className="unit-input"><input type="number" min="1" max="5" value={outputCount} onChange={(event) => setOutputCount(Number(event.target.value))} /><em>条</em></div></label>
                <div className="copy-override"><span>Hook文案</span><div className="copy-override-control"><input value={hookOverrideEnabled ? hookText : "与样片一致"} onChange={(event) => setHookText(event.target.value)} placeholder="输入新的 Hook 文案" disabled={!hookOverrideEnabled} /><button type="button" className="text-button" onClick={() => { setHookOverrideEnabled((current) => !current); if (hookOverrideEnabled) setHookText(""); }}>{hookOverrideEnabled ? "恢复样片" : "编辑"}</button></div></div>
                <label><span>颜色策略</span><select value={colorStrategy} onChange={(event) => setColorStrategy(event.target.value as "none" | "sample" | "lut")}><option value="none">保持原色视频（默认）</option><option value="sample">复刻母版颜色</option><option value="lut">品牌 LUT</option></select></label>
              </div>

              <fieldset className="transition-mode-field">
                <legend>剪辑模式</legend>
                <label className={transitionMode === "standard" ? "selected" : ""}><input type="radio" name="transitionMode" value="standard" checked={transitionMode === "standard"} onChange={() => setTransitionMode("standard")} /><span><strong>普通自动剪辑（推荐）</strong><small>大多数母版使用此模式。直接按现有规则剪辑，镜头之间硬切，不额外分析复杂转场。</small></span></label>
                <label className={transitionMode === "template_transition" ? "selected" : ""}><input type="radio" name="transitionMode" value="template_transition" checked={transitionMode === "template_transition"} onChange={() => setTransitionMode("template_transition")} /><span><strong>复刻母版转场</strong><small>仅用于明显存在复杂动态转场的母版。会只读分析母版并尝试复刻；无法稳定识别时自动降级硬切。</small></span></label>
              </fieldset>

              <label className="music-source-field"><span>BGM</span><select value={musicSource} onChange={(event) => setMusicSource(event.target.value as "template" | "library" | "upload")}><option value="template">{selectedTemplate?.bgm ? "使用母版BGM" : "使用母版BGM（不可用时从库匹配）"}</option><option value="library">从BGM库自动匹配</option><option value="upload">上传本批BGM</option></select></label>

              {(colorStrategy !== "none" || hookOverrideEnabled || musicSource === "upload") && <details className="assets-details">
                <summary>附加资源 <span>按当前设置补充</span></summary>
                <div className="mini-upload-grid">
                  {colorStrategy !== "none" && <FileDrop label="LUT文件" hint=".cube" files={lutFiles} accept=".cube" onChange={(files) => setLutFiles(files.slice(0, 1))} />}
                  {hookOverrideEnabled && <FileDrop label="Hook文案参考" hint=".docx / .txt" files={hookFiles} accept=".docx,.txt" onChange={(files) => setHookFiles(files.slice(0, 1))} />}
                  {musicSource === "upload" && <FileDrop label="BGM素材" hint="可多选" files={bgmFiles} accept="audio/*,video/*" multiple onChange={setBgmFiles} />}
                </div>
              </details>}

              {error && <div className="error-banner">{error}</div>}
              <div className="submit-row"><p>{uploadState || (selectedTemplateId ? "已使用预拆解母版，提交后直接进入产品代理与分类。" : "临时样片需要先完成识别，之后才会进入产品分类。")}</p><button className="primary-button" disabled={submitting}>{submitting ? "正在提交…" : selectedTemplateId ? "创建批次并识别产品 →" : "识别样片并创建批次 →"}</button></div>
            </form>
          </section>

        </div>}

        {view === "batch-detail" && (selected ? (
          <section className="batch-detail">
            <div className="detail-head">
              <div><span className="eyebrow">任务详情</span><h2>{selected.name}</h2><p>{selected.files.length}个文件 · {selected.sourceMode === "nas" ? "NAS原片直读" : "本机素材"} · 最长{selected.durationMax}秒 · 原速</p></div>
              <div className="detail-head-actions"><button className="back-button" onClick={() => openBatchWorkspace()}>← 任务列表</button><span className={`large-status ${statusMeta[selected.status].tone}`}>{lifecycleCurrent(selected).label}</span></div>
            </div>
            <details className="task-lifecycle-detail" open><summary><span>任务执行详情</span><small>查看当前阶段与已知记录</small></summary><BatchLifecycle batch={selected} /><BatchActivityTimeline batch={selected} recoveryEvents={recoveryByBatch[selected.id]?.events} /><FailureDiagnosticsPanel diagnostics={diagnosticsByBatch[selected.id]} /></details>
            {selected.referenceProfile ? <ProfilePanel profile={selected.referenceProfile} /> : (
              <div className={`analysis-placeholder ${activeStatuses.includes(selected.status) && selected.status !== "failed" ? "is-working" : ""}`}><div className="radar"><i/><i/><span>AI</span></div><div><strong>{selected.status === "failed" ? "任务失败" : "等待样片识别结果"}{activeStatuses.includes(selected.status) && selected.status !== "failed" ? <span className="live-dots" /> : null}</strong><p>{selected.error || "剪辑工作机会读取样片，提取镜头时长、转场、字幕安全区、色彩和CVR样式。"}{selected.lastWorkerActivityAt && activeStatuses.includes(selected.status) && selected.status !== "failed" ? <> <span className={activityClass(activityAgeSec(selected.lastWorkerActivityAt))}>已分析 {activityAgeSec(selected.lastWorkerActivityAt)} 秒</span></> : null}</p></div></div>
            )}
            {selected.productDetection ? <ProductDetectionPanel detection={selected.productDetection} evidence={selected.status === "reference_ready" ? productGroupEvidenceByBatch[selected.id] : undefined} /> : selected.referenceProfile && (
              <div className="analysis-placeholder compact is-working"><div className="radar"><i/><i/><span>衣</span></div><div><strong>正在自动识别产品<span className="live-dots" /></strong><p>无需文件夹分类，系统正在比较所有视频中的衣服底色、图案、号码、袖口与正反面关系。{selected.lastWorkerActivityAt ? <> <span className={activityClass(activityAgeSec(selected.lastWorkerActivityAt))}>已分析 {activityAgeSec(selected.lastWorkerActivityAt)} 秒</span></> : null}</p></div></div>
            )}
            {artifactEvidenceByBatch[selected.id]?.sources?.length ? <section className="artifact-review-panel">
              <div className="artifact-review-head"><div><span>ARTIFACT GATE</span><strong>素材异常审核</strong><small>仅 ACCEPT 素材可进入 ShotPool；人工决定会持久化到本批次 Evidence Sidecar。</small></div></div>
              {artifactEvidenceByBatch[selected.id]?.sources?.map((source) => {
                const file = selected.files.find((item) => item.id === source.source?.fileId);
                const pendingKey = `${selected.id}:${source.sourceKey}`;
                return <article className={`artifact-source ${source.gate?.verdict || "unknown"}`} key={source.sourceKey}>
                  <header><div><strong>{source.source?.name || source.sourceKey}</strong><small>{source.analyzer?.status === "unavailable" ? `分析器不可用：${source.analyzer.error || "等待人工"}` : `Gate：${source.gate?.verdict || "unknown"}`}</small></div><b>{source.review ? source.review.decision === "accept" ? "人工批准" : "人工拒绝" : source.gate?.verdict || "unknown"}</b></header>
                  {source.evidence?.length ? <div className="artifact-evidence-list">{source.evidence.map((item, index) => <div className="artifact-evidence" key={`${item.type}-${index}`}><strong>{item.type}</strong><span>{item.startTime.toFixed(2)}–{item.endTime.toFixed(2)}s · 连续 {item.consecutiveFrames} 帧 · 置信度 {(item.confidence * 100).toFixed(0)}%</span><small>{item.bbox ? `bbox x:${item.bbox.x.toFixed(3)} y:${item.bbox.y.toFixed(3)} w:${item.bbox.width.toFixed(3)} h:${item.bbox.height.toFixed(3)}` : "无可靠 bbox"}{item.evidence?.frames?.length ? ` · 证据帧 ${item.evidence.frames.map((time) => time.toFixed(2)).join(", ")}s` : ""}</small></div>)}</div> : <p className="artifact-empty">{source.gate?.verdict === "accept" ? "未发现可归并的时序异常。" : "没有可用的帧级证据；此素材不会自动放行。"}</p>}
                  <footer>{file && <a href={`/api/batches/${selected.id}/media/${file.id}`} target="_blank" rel="noreferrer">预览原始素材</a>}{source.gate?.verdict === "review" && !source.review && <><button className="secondary-button" disabled={artifactReviewPending === pendingKey} onClick={() => decideArtifactReview(selected.id, source.sourceKey, "accept")}>批准使用</button><button className="danger-button" disabled={artifactReviewPending === pendingKey} onClick={() => decideArtifactReview(selected.id, source.sourceKey, "reject")}>确认穿帮</button></>}{source.review && <small>决定已持久化；下一次质量导入会按此结果处理，不会自动重试。</small>}</footer>
                </article>;
              })}
            </section> : null}
            <TransitionSummary batch={selected} />
            {selected.renderSummary && <div className="quality-summary"><strong>本轮成片：{selected.renderSummary.renderedProducts}款 · 质量门禁全部通过</strong>{selected.renderSummary.excludedProducts.length > 0 && <p>主动排除 {selected.renderSummary.excludedProducts.length} 款：{selected.renderSummary.excludedProducts.map((item) => `${item.product_id}（${item.reason}）`).join("；")}</p>}</div>}
            <div className="detail-actions">
              {cancelableStatuses.includes(selected.status) && selected.status !== "cancel_requested" && <button className="cancel-button" onClick={() => cancelBatch(selected)}>取消当前任务</button>}
              {selected.status === "reference_ready" && selected.productDetection && <><input value={groupCommand} onChange={(event) => setGroupCommand(event.target.value)} placeholder="分组有误？例如：第02和03组是同一款，请合并"/><button className="secondary-button" onClick={submitRegroup} disabled={!groupCommand.trim()}>重新分组</button><button className="primary-button" onClick={approveProfile}>确认产品分组与母版，开始剪辑 →</button></>}
              {["review", "completed"].includes(selected.status) && <><input value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="例如：整批肤色再冷一点，Hook向下移动20px"/><button className="secondary-button" onClick={submitRevision} disabled={!revision.trim() || revisionPending}>{revisionPending ? "提交中…" : "提交整批修改"}</button></>}
              {["failed", "canceled"].includes(selected.status) && <button className="secondary-button" onClick={() => fetch(`/api/batches/${selected.id}/queue-reference`, { method: "POST" }).then(loadBatches)}>重新加入队列</button>}
            </div>
          </section>
        ) : (
          <section className="task-empty-state"><strong>没有找到这条任务</strong><span>它可能已被删除，或任务列表尚未刷新。</span><button className="secondary-button" onClick={() => openBatchWorkspace()}>返回任务列表</button></section>
        ))}
        </>) : view === "templates" ? (
          <section className="template-library">
            <div className="template-create">
              <div className="section-head"><div><span className="step-badge">PREP</span><h2>提前拆解新样片</h2></div><span className="speed-lock">一次分析 · 多批复用</span></div>
              <p>可一次选择多条已验证的广告样片；每条样片独立生成母版并进入后台队列，不需要等待上一条拆解完成。</p>
              <form onSubmit={createSampleTemplate}>
                <label><span>母版名称前缀</span><input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="例如：街头服装 13秒母版" /></label>
                <FileDrop label="批量上传参考样片" hint="可一次选择多条已确认效果的广告成片，最多20条" files={templateFiles} accept="video/*" multiple onChange={(files) => setTemplateFiles(files.slice(0, 20))} />
                {templateUploadState && <div className="template-batch-note">{templateUploadState}</div>}
                {error && <div className="error-banner">{error}</div>}
                <button className="primary-button template-submit" disabled={templateSubmitting}>{templateSubmitting ? "正在加入队列…" : templateFiles.length > 1 ? `批量加入拆解队列（${templateFiles.length}条） →` : "上传并开始结构拆解 →"}</button>
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
                      {item.profile ? <><p>{item.profile.summary}</p><div className="template-tags"><span>{item.profile.pace}</span><span>{item.profile.color}</span><span>{item.profile.structure.length}段结构</span><span>{transitionProfileLabel(item.transitionProfile)}</span></div></> : <p>{item.error || "后台会自动提取节奏、色彩、字幕安全区和CVR布局。"}</p>}
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
              <div className="review-empty"><strong>目前没有可审核的成片</strong><span>只有实际生成 MP4 的任务才会出现在这里。当前批次尚未完成渲染，请到任务列表查看任务状态。</span><button className="secondary-button" onClick={() => openBatchWorkspace()}>返回任务列表</button></div>
            ) : (
              <div className="review-batches">
                {reviewBatchGroups.map((group) => <section className="review-date-group" key={group.key}>
                  <div className="review-date-heading"><h3>{group.label}</h3><span>按进入审核时间（北京时间）</span></div>
                  {group.batches.map((batch) => {
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
                          <small>{outputs.length} 条成片 · 创建于 {formatTime(batch.createdAt)} · {batch.durationMax}秒以内 · 动作1.00× · 色彩：{colorStrategyLabel(batch.colorStrategy)} · {batch.renderSummary ? "质量门禁已通过" : "等待质检摘要"}</small>
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
                      <TransitionSummary batch={batch} />
                      <div className="review-videos">
                        {outputs.map((file) => <div className="review-video" key={file.id}>
                          <video controls playsInline preload="metadata" src={`/api/batches/${batch.id}/media/${file.id}`}>当前浏览器不支持视频预览</video>
                          <div className="review-video-copy"><span title={file.name}>{file.name}</span><small>{file.qualityStatus === "passed" ? `质检通过 · ${file.musicName || "独立音乐"}` : formatSize(file.size)}</small><div className="review-video-links"><button className="save-output-button" onClick={() => saveOutput(batch.id, file)}>选择保存位置</button><a href={`/api/batches/${batch.id}/media/${file.id}?download=1`}>下载 MP4</a>{file.chatcut?.manifestPath && <a href={`/api/batches/${batch.id}/chatcut/${file.id}/manifest`}>剪辑清单</a>}{file.chatcut?.status === "ready" && file.chatcut.editorUrl && <a href={file.chatcut.editorUrl} target="_blank" rel="noreferrer">打开 ChatCut</a>}{file.chatcut?.status && file.chatcut.status !== "ready" && <span className={`chatcut-status ${file.chatcut.status}`}>{file.chatcut.status === "pending" ? "等待同步 ChatCut" : file.chatcut.status === "syncing" ? `正在创建 ChatCut 项目${file.chatcut.lastActivityAt ? ` · 活动 ${timeAgo(file.chatcut.lastActivityAt)}` : ""}` : file.chatcut.status === "needs_auth" ? "需要登录 ChatCut" : "ChatCut 同步失败"}</span>}{["needs_auth", "failed"].includes(file.chatcut?.status || "") && <button className="chatcut-retry" onClick={() => retryChatCut(batch.id, file.id)}>重新同步</button>}</div>{file.chatcut?.error && <small className="chatcut-error" title={file.chatcut.error}>{file.chatcut.error}</small>}</div>
                        </div>)}
                      </div>
                      <div className="review-actions"><button className="secondary-button" onClick={() => openBatchWorkspace(batch.id)}>查看任务详情</button>{batch.status === "review" && <button className="primary-button" onClick={() => approveBatch(batch)}>确认通过并交付</button>}</div>
                    </>}
                  </article>;
                  })}
                </section>)}
              </div>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
