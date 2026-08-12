"use client";

type StatusTone = "waiting" | "running" | "review" | "completed" | "failed";
type DashboardTaskSummary = Record<StatusTone, number> & { manual?: number; processing?: number };

export type DashboardSnapshot = {
  generatedAt: string;
  system: { worker: { online: boolean }; queue: { waiting: number; running: number }; pipeline: string; killSwitch: { configured: boolean; enabled: boolean } };
  flags: Array<{ name: string; enabled: boolean; configured: boolean }>;
  tasks: DashboardTaskSummary;
  quality: { accept: number; review: number; reject: number; histogram: Record<string, number>; trend: Array<{ date: string; accept: number; review: number; reject: number }> };
  scheduler: { success: number; failed: number; failedReasons: Record<string, number> };
  renderer: { running: number; completed: number; failed: number; averageBatchElapsedSeconds: number | null; recent: Array<{ batchId: string; name: string; status: string; renderedAt: string; outputs: number }> };
  services: Record<string, {
    name: string;
    online: boolean;
    instances: number;
    status: "online" | "crashed" | "restarting" | "offline";
    restartCount: number;
    lastCrashReason: string | null;
    lastCrashAt: string | null;
    lastRestartAt: string | null;
    nextRestartAt: string | null;
    waiting: number;
    running: number;
    failed: number;
    retry: number;
    etaSeconds: number | null;
  }>;
  recentBatches: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string; stage: string; productCount: number; error?: string }>;
};

const statusLabels: Record<string, string> = { uploading: "上传中", reference_queued: "等待样片识别", analyzing_reference: "识别样片中", creating_proxies: "生成分析代理", detecting_products: "识别产品中", regroup_queued: "等待重新分组", reference_ready: "等待确认", batch_queued: "等待剪辑", editing: "剪辑中", review: "待审核", revision_queued: "等待修改", revising: "修改中", cancel_requested: "取消中", canceled: "已取消", completed: "已完成", failed: "失败" };
const scheduleReasonLabels: Record<string, string> = { "No matching shot": "未找到匹配镜头", Unknown: "未记录原因" };

function isManualBatch(batch: DashboardSnapshot["recentBatches"][number]) {
  return ["review", "reference_ready", "failed"].includes(batch.status);
}

function displayStatus(batch: DashboardSnapshot["recentBatches"][number]) {
  if (batch.status === "review") return "待审核";
  if (batch.status === "reference_ready") return "等待确认";
  if (batch.status === "failed") return "人工异常";
  return statusLabels[batch.status] || batch.status;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatElapsed(seconds: number | null) {
  if (seconds === null) return "暂无数据";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function pipelineLabel(value: string) {
  if (value === "Legacy Pipeline") return "旧流程";
  if (value === "V2 Pipeline") return "V2 全流程";
  if (value === "V2 Pilot") return "V2 试运行";
  return value;
}

function serviceStatusLabel(service: DashboardSnapshot["services"][string]) {
  if (service.online || service.status === "online") return "在线";
  if (service.status === "crashed") return "已崩溃";
  if (service.status === "restarting") return "自动重启中";
  return "离线";
}

function serviceStatusClass(service: DashboardSnapshot["services"][string]) {
  if (service.online || service.status === "online") return "service-online";
  if (service.status === "crashed") return "service-crashed";
  if (service.status === "restarting") return "service-restarting";
  return "service-offline";
}

function sortHistogram(histogram: Record<string, number>) {
  return Object.entries(histogram).sort(([, a], [, b]) => b - a);
}

export default function DashboardOverview({ data, loading, onOpenBatch, onCreateBatch, onRefresh }: { data: DashboardSnapshot | null; loading: boolean; onOpenBatch: (id: string) => void; onCreateBatch: () => void; onRefresh: () => void }) {
  if (loading && !data) return <section className="dashboard-loading">正在整理今天的任务…</section>;
  if (!data) return <section className="dashboard-loading">暂时无法读取任务概览，请刷新后重试。</section>;

  const manualBatch = data.recentBatches.find(isManualBatch);
  const processingBatch = data.recentBatches.find((batch) => !isManualBatch(batch) && ["uploading", "reference_queued", "regroup_queued", "batch_queued", "revision_queued", "analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising", "cancel_requested"].includes(batch.status));
  const completedBatch = data.recentBatches.find((batch) => batch.status === "completed");
  const inferredManual = data.tasks.review + data.tasks.failed + data.recentBatches.filter((batch) => batch.status === "reference_ready").length;
  const inferredProcessing = Math.max(0, data.tasks.waiting + data.tasks.running - data.recentBatches.filter((batch) => batch.status === "reference_ready").length);
  const manualCount = data.tasks.manual ?? inferredManual;
  const processingCount = data.tasks.processing ?? inferredProcessing;
  const nextBatch = manualBatch || processingBatch || completedBatch;
  const nextTitle = manualBatch ? "优先处理人工待办" : processingBatch ? "查看正在处理的任务" : completedBatch ? "查看已完成任务" : "今天没有待处理任务";
  const nextDescription = nextBatch ? `${nextBatch.name} · ${displayStatus(nextBatch)}` : "点击“新建批次”，开始一条新的剪辑任务。";
  const qualityTotal = data.quality.accept + data.quality.review + data.quality.reject;
  const rejectItems = sortHistogram(data.quality.histogram);
  const schedulerFailures = sortHistogram(data.scheduler.failedReasons);
  const serviceOnline = Object.values(data.services || {}).some((service) => service.online);

  return <section className="home-dashboard">
    <section className="today-focus" aria-label="今日待处理">
      <div className="today-focus-copy"><span className="eyebrow">今日工作</span><h2>先处理最重要的任务</h2><p>待审核和失败任务优先，其余任务可在最近任务中继续处理。</p><button className="primary-button dashboard-create" onClick={onCreateBatch}>＋ 新建批次</button></div>
      <button className="next-action" onClick={() => nextBatch && onOpenBatch(nextBatch.id)} disabled={!nextBatch}>
        <span>下一步</span><strong>{nextTitle}</strong><small>{nextDescription}</small><b>{nextBatch ? "去处理 →" : "暂无任务"}</b>
      </button>
    </section>

    <section className="action-cards action-cards-priority" aria-label="任务优先级摘要">
      <button className="action-card manual" onClick={() => manualBatch && onOpenBatch(manualBatch.id)} disabled={!manualBatch}><span>待人工处理</span><strong>{manualCount}</strong><small>{manualBatch ? `${displayStatus(manualBatch)}：${manualBatch.name}` : "暂无确认、审核或人工异常"}</small></button>
      <button className="action-card processing" onClick={() => processingBatch && onOpenBatch(processingBatch.id)} disabled={!processingBatch}><span>处理中</span><strong>{processingCount}</strong><small>{processingBatch ? `${displayStatus(processingBatch)}：${processingBatch.name}` : "含排队与等待开始的任务"}</small></button>
      <button className="action-card completed" onClick={() => completedBatch && onOpenBatch(completedBatch.id)} disabled={!completedBatch}><span>已完成</span><strong>{data.tasks.completed}</strong><small>{completedBatch ? completedBatch.name : "暂无已交付任务"}</small></button>
    </section>

    <section className="home-section service-queue-section" aria-label="服务队列">
      <div className="home-section-head"><div><span className="eyebrow">服务队列</span><h3>每个阶段正在做什么</h3></div><small>只读状态</small></div>
      <div className="service-queue-grid">
        {Object.values(data.services || {}).map((service) => <div className="service-queue-card" key={service.name}>
          <div className="service-queue-title"><strong>{service.name}</strong><span className={serviceStatusClass(service)}>{serviceStatusLabel(service)}</span></div>
          <div className="service-queue-stats"><span>等待 <b>{service.waiting}</b></span><span>运行 <b>{service.running}</b></span><span>失败 <b>{service.failed}</b></span><span>重试 <b>{service.retry}</b></span></div>
          <small>预计等待：{service.etaSeconds ? `${Math.ceil(service.etaSeconds / 60)} 分钟` : "暂无"} · 实例：{service.instances}</small>
          {service.status === "crashed" && <small className="service-runtime-detail service-crash-detail">🔴 已崩溃 · 原因：{service.lastCrashReason || "未知异常"}{service.lastCrashAt ? ` · ${formatDate(service.lastCrashAt)}` : ""} · 等待自动重启...</small>}
          {service.status === "restarting" && <small className="service-runtime-detail">正在自动重启{service.lastRestartAt ? ` · ${formatDate(service.lastRestartAt)}` : ""}</small>}
          {service.online && <small className="service-runtime-detail">🟢 在线 · Restart {service.restartCount} 次{service.lastRestartAt ? ` · 最后一次：${formatDate(service.lastRestartAt)}` : ""}</small>}
        </div>)}
      </div>
    </section>

    <section className="home-section recent-task-section">
      <div className="home-section-head"><div><span className="eyebrow">最近任务</span><h3>从这里继续处理</h3></div><button className="icon-button" onClick={onRefresh} aria-label="刷新任务">↻</button></div>
      <div className="recent-tasks-table" role="table">
        <div className="recent-task-row header" role="row"><span>任务名称</span><span>状态</span><span>产品</span><span>创建时间</span><span>当前进度</span></div>
        {data.recentBatches.length ? data.recentBatches.map((batch) => <button className="recent-task-row" role="row" key={batch.id} onClick={() => onOpenBatch(batch.id)}><strong>{batch.name}</strong><span><i className={`status-badge ${batch.status}`} />{displayStatus(batch)}</span><span>{batch.productCount ? `${batch.productCount} 款` : "—"}</span><time>{formatDate(batch.createdAt)}</time><span title={batch.error || batch.stage}>{isManualBatch(batch) ? `等待人工处理：${batch.error || "请查看任务记录"}` : batch.error ? `失败：${batch.error}` : batch.stage === batch.status ? displayStatus(batch) : batch.stage}</span></button>) : <div className="dashboard-empty">暂时没有任务。</div>}
      </div>
    </section>

    <div className="home-secondary-grid">
      <section className="home-section">
        <div className="home-section-head"><div><span className="eyebrow">素材质量</span><h3>质量门禁结果</h3></div><strong>{qualityTotal ? `已检查 ${qualityTotal} 段` : "等待新数据"}</strong></div>
        {qualityTotal ? <><div className="quality-summary"><div className="accept"><strong>{data.quality.accept}</strong><span>通过</span></div><div className="review"><strong>{data.quality.review}</strong><span>待确认</span></div><div className="reject"><strong>{data.quality.reject}</strong><span>未通过</span></div></div><div className="reason-list"><strong>主要未通过原因</strong>{rejectItems.slice(0, 4).map(([reason, count]) => <div key={reason}><span>{reason}</span><b>{count}</b></div>)}</div></> : <div className="empty-insight"><strong>还没有素材质量数据</strong><p>新质量门禁试运行后，这里会显示通过、待确认、未通过及主要原因。</p></div>}
      </section>

      <section className="home-section">
        <div className="home-section-head"><div><span className="eyebrow">排片结果</span><h3>镜头匹配情况</h3></div><strong>{data.scheduler.success + data.scheduler.failed ? "已有结果" : "等待新数据"}</strong></div>
        {data.scheduler.success + data.scheduler.failed ? <><div className="schedule-summary"><div><strong>{data.scheduler.success}</strong><span>排片成功</span></div><div><strong>{data.scheduler.failed}</strong><span>需要补镜头</span></div></div><div className="reason-list"><strong>未完成原因</strong>{schedulerFailures.map(([reason, count]) => <div key={reason}><span>{scheduleReasonLabels[reason] || reason}</span><b>{count}</b></div>)}</div></> : <div className="empty-insight"><strong>还没有排片结果</strong><p>新排片策略试运行后，这里会显示成功数量和缺失镜头原因。</p></div>}
      </section>
    </div>

    <details className="system-status">
      <summary><span>系统状态</span><small>{serviceOnline ? "服务在线" : "服务离线"} · {data.system.queue.running} 个任务处理中</small></summary>
      <div className="system-status-content">
        <div className="system-status-grid"><div><span>服务总览</span><strong>{serviceOnline ? "在线" : "离线"}</strong></div><div><span>当前运行方式</span><strong>{pipelineLabel(data.system.pipeline)}</strong></div><div><span>全局开关</span><strong>{data.system.killSwitch.configured ? (data.system.killSwitch.enabled ? "允许 V2" : "强制旧流程") : "未配置"}</strong></div><div><span>渲染概况</span><strong>{data.renderer.completed} 个任务已产出</strong><small>平均批次耗时：{formatElapsed(data.renderer.averageBatchElapsedSeconds)}</small></div></div>
        <div className="flag-list"><strong>功能开关（只读）</strong>{data.flags.map((flag) => <div key={flag.name}><code>{flag.name}</code><span className={flag.enabled ? "flag-on" : "flag-off"}>{flag.configured ? (flag.enabled ? "已开启" : "已关闭") : "未配置"}</span></div>)}</div>
      </div>
    </details>
  </section>;
}
