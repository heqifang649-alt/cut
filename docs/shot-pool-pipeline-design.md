# Shot Pool Pipeline 架构设计方案

> 日期：2026-08-05
> 项目：自动剪辑网站（D:\自动剪辑网站）
> 状态：设计阶段，未开始编码

---

## 一、当前架构 vs 新架构对比

### 当前 Pipeline

```
样片分析 (Codex)
  → ReferenceProfile（5段固定脚本：hook/outfit/front/sleeve/back）
    → 产品识别 (Codex)
      → Codex 直接生成 batch-edl.json
        （每个 segment 绑定 source_name + source_in + source_out）
      → 本地 ffmpeg 按 EDL 渲染
```

**核心问题：** 脚本绑定具体视频。Codex 同时负责"理解素材质量"和"选镜排布"两件事，混在一次调用里。质量筛选是隐式的（靠 prompt 描述"排除抖动模糊"），没有可审查的中间产物。

### 新 Pipeline

```
产品识别 (Codex) — 不变
  → 镜头切分 (ffmpeg scene detection)
    → 技术质量门禁 (ffmpeg: 模糊/抖动/曝光)
      → 语义质量分析 (Codex: 服装可见度/构图/朝向/细节类型...)
        → Qualified Shot Pool（带 Metadata 的镜头池）
          → 脚本模板（只描述"需要什么类型的镜头"，不绑定视频）
            → 调度器（约束求解 + 多样性 + 音乐卡点）
              → RenderPlan（等效 EDL）
                → 本地 ffmpeg 渲染（复用现有 renderer）
```

**核心理念转变：**

| 维度 | 当前 | 新方案 |
|---|---|---|
| 选镜主体 | Codex（AI） | 调度器（代码） |
| 质量判断 | 隐式（prompt 描述） | 显式（Metadata + Score） |
| 脚本与视频关系 | 绑定（EDL 写死 source_name） | 解耦（脚本只描述镜头类型需求） |
| 迭代成本 | 改脚本 → 重新跑 Codex → 重新渲染 | 改脚本 → 重新调度 → 重新渲染（秒级） |
| 可审查性 | 黑盒（Codex 内部决策） | 白盒（Shot Pool 可查看、可手动调整） |
| 失败模式 | Codex 选了差镜头但无法定位原因 | 差镜头在质量门禁就被拦截，原因明确 |

---

## 二、优势与风险评估

### 优势

**1. 镜头池可复用，分析成本摊薄**

当前每改一次脚本就要重新跑 Codex 全流程（20 分钟+）。新方案下，Shot Pool 一次分析完成，改脚本只需重新调度（< 1 秒），改音乐只需重新对齐（< 5 秒）。10 个变体输出的场景下，分析成本从 10× 降到 1×。

**2. "先剔除"比"先寻找"更鲁棒**

识别"这段抖了/糊了/衣服被挡了"比判断"哪段最好"容易得多。多级门禁（技术 → 语义 → 评分）逐层过滤，每层都有明确的拒绝理由。即使某一层判断有偏差，下游只用"通过门禁的镜头"，不会因为一个误判毁掉整条成片。

**3. 脚本与素材解耦，支持快速 A/B 测试**

同一批素材，可以瞬间生成多种脚本变体：
- 脚本 A：Hook 重动态 → Body 重整体 → Detail 重面料
- 脚本 B：Hook 重整体 → Body 重细节 → Detail 重袖口

调度器从同一个 Shot Pool 取不同子集，无需重新分析视频。

**4. 多样性可控**

当前完全依赖 Codex "自觉"不连续用同一视频。新方案在调度器里硬编码多样性约束（源视频去重惩罚），代码保证，不靠 AI 自觉。

**5. 可审查可干预**

Shot Pool 是 JSON 文件，用户可以打开看每个镜头的分数和拒绝理由，手动调整阈值或标记"这个镜头虽然分数低但我想要"。当前方案下这是不可能的。

### 风险

**R1. 镜头切分精度风险** 🟡

ffmpeg `select=gt(scene,0.3)` 的阈值需要针对服装拍摄场景调参。阈值太高会漏切（长镜头内换了角度但没切），太低会过度切分（同一动作被切成多个碎片）。

**缓解：** 设两级阈值——`scene > 0.4` 硬切分，`0.2 < scene < 0.4` 标记为"候选边界"由 Codex 确认。同时设置最小镜头时长（0.5s）和最大镜头时长（15s）防止碎片化。

**R2. 语义分析成本风险** 🟡

用户列了 17 个 Metadata 维度。如果每个镜头单独跑 Codex 分析，14 个视频 × 平均 8 个镜头 = 112 次 Codex 调用，成本和时间都不可接受。

**缓解：** 分层分析——
- 技术维度（模糊/抖动/曝光/时长）：ffmpeg 直接算，零 Codex 成本
- 语义维度（服装可见度/构图/朝向/细节类型/遮挡/Hook 潜力）：按产品分组批量送 Codex，每组一次调用（~3-5 次 Codex turn 总计）
- 综合评分：代码计算加权，不靠 AI

**R3. 调度器可能不如 Codex 会"挑"** 🟠

Codex 有视觉理解能力，能感知"这段镜头的动感更好"或"这个角度更显质感"。纯代码调度器只看数字分数，可能选出"分数高但视觉平淡"的组合。

**缓解：** 调度器只负责"不犯错"（满足约束 + 多样性 + 最低分门槛），不追求"最优"。如果用户对结果不满意，可以：
- 调整脚本模板的阈值
- 在 Shot Pool 里手动标记优选镜头
- 回退到 Codex 模式（保留兼容路径）

**R4. 过渡期兼容风险** 🟡

现有 batches.json 里有进行中的批次，EDL 格式是 Codex 生成的。新方案需要兼容已有数据。

**缓解：** 新 Pipeline 在 `detectProducts` 之后分叉。已有的 `reference_ready` / `batch_queued` / `editing` 状态的批次继续走旧路径。新批次从 `detecting_products` 完成后进入新的 `shot_detection` 状态。

**R5. 过度工程化风险** 🟠

对于 1-3 个产品的小批次，Shot Pool 的分析开销可能超过直接让 Codex 选镜的时间。

**缓解：** 设置阈值——产品数 ≤ 2 且总视频数 ≤ 6 时，走旧路径（Codex 直接 EDL）。大批次才走 Shot Pool。

---

## 三、需要修改的模块

### 新增模块

| 模块 | 职责 | 实现方式 |
|---|---|---|
| `worker/shot-detector.mjs` | ffmpeg 场景检测，输出镜头边界 | ffmpeg `select=gt(scene,X)` + `showinfo` 解析 |
| `worker/shot-quality-tech.mjs` | 技术质量分析（模糊/抖动/曝光） | ffmpeg 滤镜 + laplacian 方差 |
| `worker/shot-quality-semantic.mjs` | 语义质量分析（服装/构图/朝向等） | Codex video-use，按产品分组批量分析 |
| `worker/shot-scheduler.mjs` | 从 Shot Pool 按脚本模板选镜 | 约束求解 + 多样性惩罚 |
| `lib/shot-types.ts` | Shot / ShotPool / ScriptTemplate 类型定义 | TypeScript 类型 |

### 修改模块

| 模块 | 改动内容 |
|---|---|
| `lib/types.ts` | 新增 Shot、ShotPool、ScriptTemplate 类型；BatchStatus 新增 `shot_detection` / `shot_analysis` / `scheduling` 状态 |
| `worker/processor.mjs` | `detectProducts()` 之后插入新 Pipeline 分支：`shot_detection → shot_analysis → scheduling → rendering`；旧路径保留为 fallback |
| `worker/batch-renderer.mjs` | 新增 `renderFromPlan()` 入口，接受 RenderPlan（调度器输出）；现有 `renderBatchFromEdl()` 保留不动 |
| `lib/store.ts` | 新增 `saveShotPool()` / `loadShotPool()` 读写 shot-pool.json |
| `app/page.tsx` | 新增 Shot Pool 查看面板（镜头列表 + 质量分数 + 拒绝理由） |
| `app/globals.css` | Shot Pool 面板样式 |

### 不需要改动的模块

- `worker/chatcut-sync.mjs` — ChatCut 同步在渲染后触发，与选镜逻辑无关
- `worker/template-processor.mjs` — 模板分析独立于剪辑 Pipeline
- `worker/delivery-watcher.mjs` — 交付流程不变
- `lib/atomic-json.mjs` — 原子写入机制复用
- `app/api/health/route.ts` — 健康检查不变
- 所有 `app/api/batches/` 路由 — API 接口不变，内部数据结构扩展

---

## 四、数据结构设计

### 4.1 Shot（单个镜头）

```typescript
type Shot = {
  // 标识
  id: string;                    // UUID
  productId: string;            // 归属产品（来自 ProductDetection.groups[].id）
  sourceFileId: string;          // 源文件 ID（对应 BatchFile.id）
  sourcePath: string;            // 源视频绝对路径
  sourceFileName: string;        // 源文件名（便于展示）

  // 时间范围
  startTime: number;             // 镜头在源视频中的起始时间（秒）
  endTime: number;               // 结束时间（秒）
  duration: number;              // 时长（秒）

  // === 技术质量（ffmpeg 计算）===
  blurScore: number;             // 0-100，laplacian 方差归一化，越高越清晰
  stabilityScore: number;        // 0-100，帧间运动估计，越高越稳定
  exposureLevel: "under" | "correct" | "over";  // 直方图分析
  exposureScore: number;          // 0-100

  // === 语义质量（Codex 分析）===
  cameraMotion: "static" | "pan" | "tilt" | "zoom_in" | "zoom_out" | "handheld" | "tracking";
  composition: "full_body" | "upper_body" | "close_up" | "detail" | "wide";
  clothingVisibility: "clear" | "partial" | "obscured";
  patternVisibility: "clear" | "partial" | "obscured" | "not_applicable";
  orientation: "front" | "back" | "side_left" | "side_right" | "three_quarter";
  detailType: "sleeve" | "print" | "fabric" | "hem" | "collar" | "overall" | null;
  lighting: "good" | "adequate" | "poor";
  occlusion: "none" | "minor" | "major";

  // === 评分 ===
  hookPotential: number;          // 0-100，作为 Hook 镜头的潜力
  overallScore: number;          // 0-100，加权综合分

  // === 状态 ===
  rejected: boolean;
  rejectReason?: string;          // "blur_too_low" | "unstable" | "clothing_obscured" | ...
  rejectStage?: "tech" | "semantic" | "manual";

  // === 元信息 ===
  detectedAt: string;            // ISO 时间戳
  analyzedAt?: string;
  representativeFramePath?: string;  // 关键帧缩略图路径（用于 UI 展示）
};
```

### 4.2 ShotPool

```typescript
type ShotPool = {
  batchId: string;
  shots: Shot[];
  stats: {
    totalDetected: number;       // 切分出的镜头总数
    techRejected: number;        // 技术门禁拒绝数
    semanticRejected: number;    // 语义门禁拒绝数
    totalQualified: number;      // 进入可用池的数量
    byProduct: Record<string, {  // 按产品分组统计
      total: number;
      qualified: number;
      rejected: number;
      avgScore: number;
    }>;
  };
  createdAt: string;
  updatedAt: string;
};
```

### 4.3 ScriptTemplate（解耦脚本）

```typescript
type ScriptSlot = {
  name: string;                  // "hook" | "body" | "detail" | "back"
  purpose: string;              // 人类可读的用途描述
  duration: number;             // 目标时长（秒）
  requirements: {
    // 约束条件——所有字段都是可选的，未设置表示不限制
    minScore: number;           // 最低 OverallScore
    composition?: ("full_body" | "upper_body" | "close_up" | "detail" | "wide")[];
    orientation?: ("front" | "back" | "side_left" | "side_right" | "three_quarter")[];
    detailType?: ("sleeve" | "print" | "fabric" | "hem" | "collar" | "overall")[];
    cameraMotion?: ("static" | "pan" | "tilt" | "zoom_in" | "zoom_out" | "handheld" | "tracking")[];
    minDuration: number;        // 最小可用时长
    maxDuration: number;         // 最大可用时长
    minHookPotential?: number;  // Hook 专属：最低 Hook 潜力分
  };
};

type ScriptTemplate = {
  name: string;
  totalDuration: number;        // 成片总时长（秒）
  slots: ScriptSlot[];
  cuts: number[];               // 音乐卡点时间（秒），如 [3, 6, 8.1, 10]
  // 脚本不包含任何 source_name / source_in / source_out
};
```

**示例脚本（用户描述的场景）：**

```json
{
  "name": "gc-standard-5slot",
  "totalDuration": 12,
  "cuts": [3, 6, 8.1, 10],
  "slots": [
    {
      "name": "hook",
      "purpose": "首帧商品可见，动态吸引停留",
      "duration": 3,
      "requirements": {
        "minScore": 90,
        "minHookPotential": 80,
        "composition": ["full_body", "upper_body"],
        "cameraMotion": ["pan", "zoom_in", "tracking", "handheld"],
        "minDuration": 0.8,
        "maxDuration": 3.0
      }
    },
    {
      "name": "body",
      "purpose": "整体展示，建立版型和主图认知",
      "duration": 3,
      "requirements": {
        "minScore": 85,
        "composition": ["full_body", "upper_body"],
        "orientation": ["front", "three_quarter"],
        "minDuration": 1.0,
        "maxDuration": 3.0
      }
    },
    {
      "name": "detail",
      "purpose": "袖口/印花/面料特写",
      "duration": 2.1,
      "requirements": {
        "minScore": 85,
        "composition": ["close_up", "detail"],
        "detailType": ["sleeve", "print", "fabric", "collar"],
        "minDuration": 0.8,
        "maxDuration": 2.1
      }
    },
    {
      "name": "back",
      "purpose": "背面或最佳补充镜头",
      "duration": 2,
      "requirements": {
        "minScore": 80,
        "orientation": ["back", "side_left", "side_right"],
        "minDuration": 0.8,
        "maxDuration": 2.0
      }
    },
    {
      "name": "closing",
      "purpose": "末帧保留 CVR 阅读时间",
      "duration": 1.9,
      "requirements": {
        "minScore": 85,
        "composition": ["full_body", "upper_body"],
        "minDuration": 0.8,
        "maxDuration": 1.9
      }
    }
  ]
}
```

### 4.4 RenderPlan（调度器输出，兼容现有 renderer）

```typescript
type ScheduledShot = {
  slot: string;                  // 对应 ScriptSlot.name
  shotId: string;                // Shot Pool 中的 Shot ID
  productId: string;
  sourceFileId: string;
  sourceFileName: string;
  sourcePath: string;
  sourceIn: number;             // 在源视频中的起始时间
  sourceOut: number;            // 结束时间
  duration: number;             // 使用时长
  score: number;                // 该镜头的 OverallScore
};

type RenderPlan = {
  batchId: string;
  scriptTemplate: ScriptTemplate;
  products: Array<{
    productId: string;
    displayName: string;
    scheduledShots: ScheduledShot[];
  }>;
  // RenderPlan 可直接转换为 batch-edl.json 格式
  // 供 renderBatchFromEdl() 使用，无需改 renderer
};
```

### 4.5 BatchStatus 扩展

```typescript
type BatchStatus =
  | "uploading"
  | "reference_queued"
  | "analyzing_reference"
  | "creating_proxies"
  | "detecting_products"
  | "regroup_queued"
  | "reference_ready"
  // === 新增 ===
  | "shot_detection"             // ffmpeg 场景切分
  | "shot_analysis"              // Codex 语义质量分析
  | "scheduling"                 // 调度器选镜
  // === 新增结束 ===
  | "batch_queued"
  | "editing"
  | "review"
  | "revision_queued"
  | "revising"
  | "cancel_requested"
  | "canceled"
  | "completed"
  | "failed";
```

### 4.6 Batch 扩展

```typescript
type Batch = {
  // ... 现有字段不变 ...

  // === 新增 ===
  shotPool?: ShotPool;           // 镜头池（detectProducts 后生成）
  scriptTemplate?: ScriptTemplate;  // 当前使用的脚本模板
  renderPlan?: RenderPlan;       // 调度器输出的渲染计划
  pipelineMode?: "legacy" | "shot_pool";  // 标识走哪条 Pipeline
  // === 新增结束 ===
};
```

---

## 五、新模型引入确认

**是的，必须引入以下新模型：**

### 1. ShotPool 模型

持久化为 `storage/batches/{batchId}/shot-pool.json`。包含所有切分出的镜头及其完整 Metadata。这是整个新 Pipeline 的核心数据结构。

### 2. Shot Metadata 模型

17 个维度的质量描述。分为三层：
- **技术层**（ffmpeg 计算）：blurScore, stabilityScore, exposureLevel, exposureScore
- **语义层**（Codex 分析）：cameraMotion, composition, clothingVisibility, patternVisibility, orientation, detailType, lighting, occlusion
- **评分层**（代码计算）：hookPotential, overallScore

### 3. QualityScore 模型

OverallScore 的计算公式（代码实现，非 AI）：

```
overallScore =
  blurScore      × 0.15 +
  stabilityScore × 0.15 +
  exposureScore  × 0.10 +
  lightingScore  × 0.10 +    // good=100, adequate=70, poor=30
  clothingScore  × 0.20 +    // clear=100, partial=50, obscured=0
  patternScore   × 0.10 +    // clear=100, partial=50, obscured=0
  compositionScore × 0.10 +  // full_body=90, upper_body=85, close_up=80, detail=75, wide=70
  occlusionScore × 0.10       // none=100, minor=60, major=0
```

hookPotential 单独计算（强调动态感和视觉冲击力）：

```
hookPotential =
  overallScore × 0.5 +
  motionBonus × 0.3 +         // handheld/tracking/zoom_in 加分
  clarityBonus × 0.2          // clothingVisibility=clear 且 patternVisibility=clear 加分
```

### 4. ScriptTemplate 模型

脚本与视频解耦的核心。脚本只描述"每个槽位需要什么类型的镜头"，不包含任何视频引用。

### 5. 不需要的模型

- **不需要新的 Codex Schema** — 语义分析复用现有的 `outputSchema` 机制
- **不需要新的存储引擎** — Shot Pool 用 JSON 文件，复用现有 atomic-json 机制
- **不需要新的渲染器** — 调度器输出 RenderPlan，可转换为现有 EDL 格式

---

## 六、镜头多样性策略

### 问题

如果产品只有 2-3 个源视频，调度器可能连续从同一视频取镜头，导致成片视觉单调。

### 解决方案：源视频去重惩罚

调度器在选镜时，对每个候选镜头计算**有效分数**：

```
effectiveScore = shot.overallScore - sourcePenalty
```

其中 `sourcePenalty` 基于该镜头的源视频在**最近 N 个已选镜头中的出现次数**：

```typescript
function calculateSourcePenalty(
  shot: Shot,
  recentSelections: ScheduledShot[],
  config: DiversityConfig
): number {
  const recentFromSameSource = recentSelections
    .slice(-config.windowSize)  // 看最近 N 个选择
    .filter(s => s.sourceFileId === shot.sourceFileId)
    .length;

  if (recentFromSameSource === 0) return 0;
  if (recentFromSameSource === 1) return config.penaltyPerRepeat;      // 扣 10 分
  if (recentFromSameSource === 2) return config.penaltyPerRepeat * 3;  // 扣 30 分
  return config.penaltyPerRepeat * 6;                                   // 扣 60 分
}
```

### DiversityConfig

```typescript
type DiversityConfig = {
  windowSize: number;            // 回看最近几个已选镜头（默认 3）
  penaltyPerRepeat: number;      // 每次重复的基本惩罚（默认 10）
  maxConsecutiveFromSameSource: number;  // 同一源视频最多连续出现几次（默认 2，硬约束）
  allowSameSourceNonConsecutive: boolean; // 非连续时是否允许同一源（默认 true）
};
```

### 调度器选镜流程

```
对于脚本的每个 slot（按顺序）:
  1. 从 ShotPool 中筛选该产品的所有 qualified shots
  2. 过滤：满足 slot.requirements（minScore, composition, orientation...）
  3. 如果候选数 < 1：放宽约束（降低 minScore 5 分）重试，最多放宽 3 次
  4. 对每个候选计算 effectiveScore = overallScore - sourcePenalty
  5. 如果有候选违反 maxConsecutiveFromSameSource 硬约束，排除
  6. 从剩余候选中选 effectiveScore 最高的
  7. 记录到 recentSelections，更新源视频使用计数
  8. 如果该 slot 需要 duration > 候选的 duration，允许从同一源视频取多个连续片段拼接
```

### 边界情况处理

**情况 1：候选不足**
- 放宽 minScore（每次降 5 分，最多 3 次）
- 如果仍不足，放宽 composition/orientation 约束
- 如果最终无候选，标记该产品为 `excluded`（复用现有 `excluded_products` 机制）

**情况 2：同一源视频是唯一选择**
- 允许使用，但在 RenderPlan 中标记 `diversityWarning: true`
- UI 显示警告"该产品镜头多样性不足，建议补充拍摄素材"

**情况 3：用户手动标记优选镜头**
- ShotPool 中的 Shot 可以有 `manualPreferred: boolean` 字段
- 调度器对 manualPreferred 的镜头加 20 分 bonus
- 允许用户覆盖 AI 的质量评分

---

## 七、完整 Pipeline 设计

### 7.1 Pipeline 流程图

```
[1] 样片分析 (Codex)
    ↓ ReferenceProfile
    │
[2] 产品识别 (Codex)
    ↓ ProductDetection
    │
[3] Proxy 转码 (ffmpeg)
    ↓ 540p/6fps 代理视频
    │
[4] 镜头切分 (ffmpeg scene detection)              ← 新增
    │  对每个产品的每个视频执行场景检测
    │  输出: 原始镜头列表（只有时间范围，无质量信息）
    ↓ Raw Shots
    │
[5] 技术质量门禁 (ffmpeg 分析)                      ← 新增
    │  对每个镜头计算 blurScore / stabilityScore / exposureScore
    │  拒绝: blurScore < 30 或 stabilityScore < 30 或 exposure = "under/over" 极端
    │  为通过的镜头提取关键帧（用于 Codex 分析和 UI 展示）
    ↓ Tech-Qualified Shots
    │
[6] 语义质量分析 (Codex, 按产品分组)                 ← 新增
    │  对每个产品的所有通过技术门禁的镜头，批量送 Codex 分析
    │  Codex 看每个镜头的关键帧，输出: cameraMotion, composition, clothingVisibility,
    │  patternVisibility, orientation, detailType, lighting, occlusion, hookPotential
    │  一次 Codex turn 分析一个产品的所有镜头（~5-15 个镜头）
    ↓ Fully-Analyzed Shots
    │
[7] 综合评分 + 拒绝 (代码计算)                      ← 新增
    │  对每个镜头计算 overallScore
    │  拒绝: overallScore < 60 或 clothingVisibility = "obscured" 或 occlusion = "major"
    ↓ Qualified Shot Pool
    │  持久化: storage/batches/{id}/shot-pool.json
    │
[8] 脚本模板选择 / 配置                             ← 新增
    │  从预设脚本库选择，或基于 ReferenceProfile 自动生成
    │  脚本只描述每个 slot 需要什么类型的镜头
    ↓ ScriptTemplate
    │
[9] 调度器选镜 (代码, < 1 秒)                       ← 新增
    │  对每个产品:
    │    对脚本的每个 slot:
    │      从 ShotPool 筛选满足 requirements 的镜头
    │      应用多样性惩罚
    │      选择 effectiveScore 最高的
    │  输出: RenderPlan
    ↓ RenderPlan
    │  持久化: storage/batches/{id}/edit/render-plan.json
    │
[10] EDL 转换 (代码, < 100ms)                      ← 新增
    │  RenderPlan → batch-edl.json 格式
    │  复用现有 EDL 的 master 结构（duration, cuts, hook, cvr, grade...）
    │  只替换 products[].segments 的 source_name/source_in/source_out
    ↓ batch-edl.json
    │
[11] 本地渲染 (ffmpeg, 现有逻辑)                   ← 复用
    │  renderBatchFromEdl() 不需要修改
    │  调色 → 拼接 → 音乐卡点 → 字幕/CVR 叠加 → 质检
    ↓ Output MP4s
    │
[12] 审核 / 交付 / ChatCut 同步                     ← 复用
```

### 7.2 各阶段进度映射

```
0-17%   : 上传 + 样片分析 (现有)
18-27%  : 产品识别 + Proxy 转码 (现有)
28%     : 镜头切分 (新增, ~2 分钟)
  └─ 显示 "正在切分镜头 (12/14 视频)"
30%     : 技术质量门禁 (新增, ~3 分钟)
  └─ 显示 "技术质量分析 (45/112 镜头)"
35%     : 语义质量分析 (新增, ~8-15 分钟, Codex)
  └─ 显示 "AI 分析镜头质量 - 产品 2/4"
  └─ 显示 "已分析 127 秒" (实时跳动)
45%     : 综合评分 + 生成 Shot Pool (新增, < 10 秒)
  └─ 显示 "镜头池就绪: 87 个合格 / 25 个拒绝"
46%     : 脚本模板配置 (新增, < 1 秒)
47%     : 调度器选镜 (新增, < 1 秒)
  └─ 显示 "正在调度镜头组合"
48%     : EDL 转换 (新增, < 1 秒)
50-97%  : 本地渲染 (现有, ffmpeg)
  └─ 显示 "渲染奶油色梵高花束 (3/11)"
100%    : 完成
```

### 7.3 Codex 调用次数对比

| 阶段 | 当前方案 | 新方案 |
|---|---|---|
| 样片分析 | 1 turn | 1 turn（不变） |
| 产品识别 | 1 turn | 1 turn（不变） |
| 镜头切分 | — | 0 turn（ffmpeg） |
| 技术质量 | — | 0 turn（ffmpeg） |
| 语义质量 | — | N turn（N = 产品数，通常 2-5） |
| 选镜 + EDL | 1 turn | 0 turn（代码调度） |
| 修订 | 1 turn/次 | 0 turn（改脚本 → 重新调度） |
| **总计** | **4+ turn** | **3 + N turn**（N 通常 2-5） |

关键区别：新方案的 Codex 调用是**分析型**的（看镜头 → 打标签），比当前方案的**决策型**调用（选镜 + 生成 EDL）更稳定、更不容易超时。

### 7.4 修订流程变化

**当前：** 用户反馈 → Codex 重新生成 EDL → 重新渲染（20 分钟+）

**新方案：**
- 用户反馈"Hook 不够动感" → 调整脚本的 hook slot requirements → 重新调度 → 重新渲染（< 1 秒调度 + 渲染时间）
- 用户反馈"第 3 段太晃" → 在 Shot Pool 标记该镜头 rejected → 重新调度 → 重新渲染
- 用户反馈"换个音乐" → 重新计算 beat offset → 重新渲染（现有逻辑已支持）

只有需要重新分析视频内容时（如新增了源视频、产品识别有误）才需要 Codex 介入。

### 7.5 Pipeline 模式切换

```typescript
// processor.mjs tick() 中的分叉逻辑
async function tick() {
  // ...
  if (batch.status === "reference_ready") {
    // 判断走哪条 Pipeline
    const productCount = batch.productDetection?.groups?.length || 0;
    const videoCount = batch.files.filter(f => f.kind === "products").length;

    if (productCount > 2 || videoCount > 6) {
      // 大批次走 Shot Pool Pipeline
      batch.pipelineMode = "shot_pool";
      batch.status = "shot_detection";
    } else {
      // 小批次走 Legacy Pipeline
      batch.pipelineMode = "legacy";
      batch.status = "batch_queued";
    }
  }

  if (batch.status === "shot_detection") await detectShots(batch);
  if (batch.status === "shot_analysis") await analyzeShotQuality(batch);
  if (batch.status === "scheduling") await scheduleAndRender(batch);
  // ...
}
```

### 7.6 向后兼容

- 现有 `batch_queued` / `editing` 状态的批次继续走旧路径
- 新批次在 `reference_ready` 后自动选择 Pipeline 模式
- `batch-edl.json` 格式不变——新方案的 RenderPlan 最终也转换为同一格式
- `renderBatchFromEdl()` 完全复用，零修改
- ChatCut manifest 生成逻辑不变

---

## 八、实施路线建议

### Phase 1：Shot Detection + 技术质量门禁（1-2 天）

- 实现 `shot-detector.mjs`（ffmpeg 场景检测）
- 实现 `shot-quality-tech.mjs`（模糊/抖动/曝光分析）
- 在 processor.mjs 中接入 `shot_detection` 状态
- UI 显示镜头切分进度和技术质量统计

### Phase 2：语义质量分析 + Shot Pool（1-2 天）

- 实现 `shot-quality-semantic.mjs`（Codex 批量分析）
- 定义 Codex 输出 Schema（语义 Metadata）
- 实现 overallScore 计算
- 持久化 shot-pool.json
- UI 展示 Shot Pool 面板

### Phase 3：脚本模板 + 调度器（1-2 天）

- 定义 ScriptTemplate 格式
- 预置默认脚本模板（基于现有 5-slot 结构）
- 实现 `shot-scheduler.mjs`（约束求解 + 多样性惩罚）
- RenderPlan → EDL 转换
- 接入 processor.mjs 的 `scheduling` 状态

### Phase 4：集成测试 + 修订流程（1 天）

- 端到端测试：从产品识别到成片输出
- 脚本变体 A/B 测试
- 修订流程验证（改脚本 → 重新调度）
- 性能基准对比

### 总计：4-7 个工作日

---

## 九、关键设计决策总结

| 决策点 | 选择 | 理由 |
|---|---|---|
| 镜头切分工具 | ffmpeg scene detection | 零依赖、已安装、足够精确 |
| 技术质量分析 | ffmpeg 滤镜 | 零 Codex 成本、可重复 |
| 语义质量分析 | Codex 按产品分组批量 | 平衡精度和成本 |
| 综合评分 | 代码加权计算 | 可审计、可调整 |
| 调度算法 | 贪心 + 多样性惩罚 | 简单可靠、< 1 秒 |
| 渲染 | 复用现有 renderer | 零修改、保证一致性 |
| EDL 格式 | 保持不变 | 向后兼容 |
| Pipeline 切换 | 按批次规模自动选择 | 小批次不浪费开销 |
| 修订方式 | 改脚本/Shot Pool → 重新调度 | 秒级迭代 |
