# Architecture Simplification Review

> 日期：2026-08-05
> 角色：Staff Engineer
> 目标：收敛。不增加新功能、新模块、新 AI 能力。只做减法。
> 审查范围：validator-boundary-redesign.md + dual-pipeline-architecture.md
> 原则：如果人工 10 秒能完成，AI 需要 2 分钟且不准，那就人工做。如果代码 3 行能解决，不建模块。

---

## 1. Metadata Budget 位置

### 问题

当前流程：

```
Validator → ShotPool → Metadata Budget → Scheduler
                        ↑
                  ShotPool 存的是半成品
```

Shot 先写入 ShotPool（缺 productVisibility / productCentered / motionEnergy），然后 Metadata Budget 补字段。这意味着 ShotPool 在某个时间窗口内存在不完整的 Shot。

### 两种方案对比

| 维度 | 方案 A（当前）：Validator → ShotPool → Budget → Scheduler | 方案 B（提议）：Validator → Budget → ShotPool → Scheduler |
|---|---|---|
| ShotPool 数据一致性 | ⚠️ 存在半成品窗口 | ✅ 入池即完整 |
| Crash Recovery | 需扫描 ShotPool 找缺字段的重算 | 重新从 Validator 开始即可 |
| Worker 中断恢复 | 需标记"哪些 Shot 已入池但未预算" | 无中间状态，直接重跑 |
| ShotPool 语义 | "大部分完整，个别可能缺字段" | "每个 Shot 都是完整的" |
| 实现复杂度 | 需要补偿逻辑（启动时扫描不完整 Shot） | 无补偿逻辑 |

### 判决

**方案 B。Metadata Budget 移到 ShotPool 之前。**

理由：

1. **ShotPool 是 Source of Truth，不是工作台。** 任何读取 ShotPool 的模块（Scheduler、Review UI、统计面板）都应该能假设里面的数据是完整的。如果允许半成品存在，每个消费者都要写防御代码检查字段是否存在。

2. **Crash Recovery 更简单。** Worker 崩溃后重启，不需要扫描 ShotPool 找不完整记录。直接从 Validator 重新跑——反正 Validator 是幂等的，同一个视频跑两次结果一样。

3. **不需要"入池标记"。** 方案 A 需要某种标记来区分"已入池但未预算"和"已入池且已预算"的 Shot。方案 B 不需要——没入池就是没入池。

4. **Metadata Budget 的计算量很小（~1s/视频）。** 放在 ShotPool 前面不构成瓶颈。

### 修正后的流程

```
Validator (accept)
      │
      ▼
Metadata Budget (~1s)
  compute productVisibility / productCentered / motionEnergy
      │
      ▼
ShotPool (写入完整 Shot)
      │
      ▼
Scheduler (读缓存字段, < 1ms 匹配)
```

**ShotPool 里不存在半成品。入池即完整。**

---

## 2. Prompt Parser 是否应该删除

### 问题

当前设计有 `prompt-parser.mjs`，解析 AI 生成平台输出的 Prompt 文本，正则匹配关键词 → tags。

用户的判断：Prompt 属于生成平台。本系统只负责质量检测 → ShotPool → 剪辑。不应该解析 Prompt。

### 分析

**用户判断完全正确。**

当前 Prompt Parser 存在三个问题：

**问题 1：耦合。** Prompt 的格式由生成平台决定。Runway 的 Prompt 格式和 Veo 的不同，Kling 的和 Pika 的不同。本系统每接入一个新平台就要维护一套正则规则。这是不必要的耦合。

**问题 2：脆弱。** 正则匹配 Prompt 文本是脆弱的。设计师写 "close up"（没有连字符）就匹配不上 `close.?up`。设计师写 "CU"（行业缩写）也匹配不上。每漏一个匹配就是一条丢失的 tag。

**问题 3：职责越界。** 本系统的职责是"素材质量检测 → 删除废镜头 → ShotPool → 自动剪辑"。解析 Prompt 是生成平台的事。生成平台知道它生成了什么——它应该直接输出结构化 metadata，而不是输出一段自然语言让下游猜。

### 判决

**删除 prompt-parser.mjs。**

替换为：**Metadata Import**——本系统只读取生成平台提供的结构化 metadata。

### 输入契约

生成平台（或人工导入时）提供 JSON sidecar 文件：

```json
{
  "video": "runway_001.mp4",
  "tags": ["close_up", "zoom_in", "studio", "detail"],
  "duration": 5.0,
  "platform": "runway",
  "prompt": "Close-up shot of a red lipstick..."  // 可选，仅存档参考
}
```

本系统不解析 `prompt` 字段。只读 `tags` 数组。

### 实现方式

不需要新模块。`ai-ingest.mjs` 里加 3 行代码读 JSON sidecar：

```javascript
const sidecar = JSON.parse(fs.readFileSync(videoPath.replace('.mp4', '.json'), 'utf-8'));
const tags = sidecar.tags;
```

### 如果生成平台不提供 tags？

两种情况：

1. **生成平台支持结构化输出**（Runway API、Veo API 都支持）：直接用。零成本。
2. **设计师手动生成**（用网页版 Runway）：设计师在导入时手动填 tags。10 秒搞定。比写正则解析器维护 19 条规则更可靠。

### 删除清单

| 删除 | 替代 |
|---|---|
| `prompt-parser.mjs` | `ai-ingest.mjs` 内 3 行 JSON 读取 |
| TAG_MAPPING 正则表（19 条规则） | 生成平台 JSON sidecar |
| ValidationResult 里的 `tags` 字段 | tags 是输入，不是 Validator 输出 |

### 连带修正

Validator 当前返回 `tags: string[]`。这是越界——Validator 的职责是质量检测，不应该输出 tags。tags 是输入（来自 Metadata Import），直接透传到 ShotPool，不经过 Validator 的处理。

修正后：

```
Metadata Import (tags 来自 JSON sidecar)
      │
      ▼
Validator (只输出 verdict + rejectReason + artifacts)
      │ accept
      ▼
Metadata Budget (补充 creative 缓存字段)
      │
      ▼
ShotPool (tags + creative fields 都已就绪)
```

Validator 不碰 tags。tags 从入口到出口直通。

---

## 3. Validator 是否需要返回 Artifact Location

### 问题

是否应该在 ValidationResult 里增加定位信息：

```json
{
  "type": "human:hand_anomaly",
  "timestamp": 2.3,
  "bbox": [120, 80, 200, 160]
}
```

让 UI 可以直接跳到第 2.3 秒、高亮画面左上角区域。

### 哪些 Artifact 可以定位？

| Artifact | 能否返回 timestamp | 能否返回 bbox | 理由 |
|---|---|---|---|
| hand_anomaly | ✅ | ✅ | 手部区域可检测 |
| face_drift | ✅ | ✅ | 面部区域可检测 |
| limb_mutation | ✅ | ✅ | 肢体区域可检测 |
| product_dissolution | ✅ | ✅ | 产品区域可跟踪 |
| product_deformation | ✅ | ✅ | 同上 |
| texture_boil | ⚠️ 范围 | ❌ | 全画面，不是局部 |
| global_flicker | ❌ | ❌ | 全局问题 |
| bg_flicker | ⚠️ 范围 | ⚠️ 区域 | 背景区域可分割但不精确 |
| stutter | ✅ | ❌ | 时间点明确，但无空间位置 |
| low_resolution | ❌ | ❌ | 全局属性 |
| camera_jump | ✅ | ❌ | 时间点明确 |
| non_physical | ✅ | ⚠️ | 物体可跟踪但不总是精确 |

### 判决

**不增加 Artifact Location。**

理由：

**1. 复杂度不对等。**

增加 location 意味着：
- Layer 3 AI 模型必须输出 bounding box（训练目标从分类变成检测，标注成本 5-10 倍）
- Layer 1-2 代码必须追踪每个检测到的问题的时间戳和空间位置
- Shot schema 需要存储 location 数组
- Review UI 需要渲染视频播放器 + bbox 叠加层 + 时间轴标记

这是 4 个模块的改动。换来什么？

**2. 设计师不需要它。**

设计师看到 reject reason `human:hand_anomaly`，打开视频，10 秒内就能看到手指问题——因为手指异常是肉眼可见的。视频通常 5-10 秒长，从头看一遍就能定位。

**3. Reject reason 已经足够指导修复。**

设计师看到 `product:dissolution` → 知道产品消失了 → 在 Prompt 里加 "product remains visible throughout"。不需要知道是在第 2.3 秒消失的。

**4. 如果以后真的需要，可以加。**

ValidationResult 的 artifacts 数组可以以后扩展为可选包含 location。这是增量改动，不需要现在设计。

### 结论

**不增加。** 当前 RejectReason 字符串（如 `human:hand_anomaly`）已经足够指导设计师修复。Location 信息是锦上添花，但代价是 4 个模块的复杂度上升。不值得。

---

## 4. Human Review Override

### 问题

Human Review 是否应该支持 Override：
- Validator: Reject → 人工: Accept（救回误杀）
- Validator: Accept → 人工: Reject（拦截漏网）

### 分析

**两种 Override 的实际场景不同：**

**Reject → Accept（救回误杀）：**

Validator 有误杀率。Layer 1-2 是代码检测，误杀率低。Layer 3 是 AI 模型，误杀率可能 5-10%。10000 视频/天，如果 25% 被 reject = 2500 条，其中 5-10% 误杀 = 125-250 条好视频被扔进废片桶。

这些视频是花了钱生成的（Runway ~$0.5/条，Veo ~$0.3/条）。每天浪费 $60-125。一年 $20K-45K。

更重要的：设计师看到一条 reject 的视频觉得没问题，如果没有 override 路径，只能重新生成。重新生成 = 再花钱 + 不保证更好。

**Accept → Reject（拦截漏网）：**

Validator 有漏检率。漏检的废片进入 ShotPool，被 Scheduler 选中，渲染到最终成片里。设计师在 Review 阶段看成片时发现问题。

但这个场景**已经被现有 Review 流程覆盖**。设计师审核最终成片，不满意 → 改 slot / 换 shot → 重新渲染。不需要单独的"Accept Override"。

### 判决

**增加 Reject → Accept Override。不增加 Accept → Reject Override。**

| 场景 | 是否增加 | 理由 |
|---|---|---|
| Reject → Accept | ✅ 增加 | 废片桶里的视频没有出路。设计师看到误杀只能重新花钱生成。Override 零成本解决。 |
| Accept → Reject | ❌ 不增加 | 已被现有 Review 流程覆盖。设计师看最终成片不满意 → 换 shot → 重渲染。不需要在 ShotPool 层面拦截。 |

### 实现方式

**不新增模块。** 在现有 Review UI 的废片桶视图加一个 "Override Accept" 按钮。

```
RejectBin 视图:
  ┌──────────────────────────────────────┐
  │ runway_001.mp4                        │
  │ Reject: human:hand_anomaly (0.87)     │
  │                                       │
  │  [▶ 播放]  [✅ Override Accept]       │
  └──────────────────────────────────────┘
```

点击 Override Accept → Shot 从 RejectBin 移入 ShotPool（走 Metadata Budget → ShotPool）。

### 数据结构

RejectBin 记录增加一个字段：

```typescript
type RejectBin = {
  videoPath: string;
  rejectReason: RejectReason;
  rejectedAt: string;
  overridden?: boolean;           // 新增：是否被人工 override
  overriddenBy?: string;          // 新增：操作人
  overriddenAt?: string;          // 新增：时间
};
```

**不用于模型训练，不用于 Prompt 优化。只用于修正 Validator 判断。** 但这些 override 记录天然是标注数据——如果以后想用于模型改进，数据已经在那里了。

### 不增加的

- 不增加 Accept → Reject 路径（现有 Review 覆盖）
- 不增加 override 统计面板（YAGNI）
- 不增加 override 审批流程（设计师直接操作，不需要二级确认）

---

## 5. 模块职责最终审查

### 逐模块检查

| 模块 | 职责 | 只做一件事？ | 问题 |
|---|---|---|---|
| Metadata Import (ai-ingest.mjs) | 读 JSON sidecar → tags + video path | ✅ | 无 |
| Validator (ai-video-validator.mjs) | 检测视频技术缺陷 → accept/reject/review | ✅ | **修正：不再返回 tags** |
| Metadata Budget (metadata-budget.mjs) | 计算 productVisibility / productCentered / motionEnergy | ✅ | **修正：移到 ShotPool 之前** |
| ShotPool | 存储完整 Shot | ✅ | 无 |
| Scheduler (shot-scheduler.mjs) | Tag + Slot 匹配 → RenderPlan | ✅ | 无 |
| Renderer (batch-renderer.mjs) | ffmpeg 拼接 → MP4 | ✅ | 无 |
| Review UI | 人工审核成片 + 废片桶 override | ✅ | 无 |

### 发现的越界点

**越界 1：Validator 返回 tags**

当前 ValidationResult 包含 `tags: string[]`。tags 来自 Prompt Parser。删除 Prompt Parser 后，tags 来自 Metadata Import。Validator 不应该输出 tags——它是质量检测器，不是 tag 生成器。

**修正：** tags 从 Metadata Import 直通到 ShotPool。Validator 只接收 video path 作为输入，输出 verdict + rejectReason + artifacts。

```
修正前:
  Metadata Import → Validator(tags 输出) → ShotPool

修正后:
  Metadata Import ──→ tags 直通 ──→ ShotPool
                  └→ Validator(video only) → verdict → ShotPool
```

**越界 2：Scheduler 包含 brandColorPalette**

当前 Slot 定义有 `brandColorPalette?: string[]`，Scheduler 在匹配时计算色彩距离。

这是 Scheduler 的职责吗？是的——Scheduler 是唯一知道品牌规范的模块。色彩匹配是"这个 Shot 适合这个 Slot 吗"的判断，属于 Scheduler。

但问题在于：**色彩匹配需要计算**。如果 Scheduler 实时计算色彩距离，它就不只是"读缓存 + 匹配"了，而是"读视频 + 计算 + 匹配"。

**修正：** 如果保留 brandColorPalette，色彩匹配值应该在 Metadata Budget 阶段预算（主色提取 ~0.1s），缓存到 Shot 上。Scheduler 只读缓存值做比较。

但这增加了一个缓存字段 `dominantColor`。考虑到：
- 色彩匹配目前是 Slot 定义里的可选字段
- 大部分 Slot 不需要色彩匹配
- 增加字段 = 增加 Metadata Budget 复杂度

**判决：删除 brandColorPalette。** 色彩匹配在 v1 不需要。如果以后某个品牌确实需要色彩匹配，可以在 Metadata Budget 加 `dominantColor` 字段，在 Slot 加 `preferredColorPalette`。但不是现在。

### 修正后的 Slot 定义

```typescript
type Slot = {
  id: string;
  label: string;
  requireTags: string[];
  preferTags?: string[];
  minDuration?: number;
  maxDuration?: number;
  // 从 Validator 移入的创意判断（保留）
  minProductVisibility?: number;
  requireProductCentered?: boolean;
  requireMotionEnergy?: "high" | "medium" | "low";
  // 删除
  // brandColorPalette?: string[];   ← 删除
};
```

### 修正后的 Shot schema

```typescript
type Shot = {
  id: string;
  source: string;
  path: string;
  start: number;
  end: number;
  duration: number;
  tags: string[];          // 来自 Metadata Import，不经过 Validator
  reject: boolean;
  rejectReason?: string;
  origin: "real" | "ai";
  // Metadata Budget 缓存字段
  productVisibility?: number;
  productCentered?: boolean;
  motionEnergy?: "high" | "medium" | "low";
};
```

### 修正后的 ValidationResult

```typescript
type ValidationResult = {
  verdict: "accept" | "reject" | "review";
  rejectReason?: RejectReason;
  artifacts: { type: string; confidence: number }[];
  // 删除
  // tags: string[];        ← 删除，tags 不经过 Validator
  // 删除
  // metrics: { ... }       ← 删除，不需要返回每层耗时
};
```

---

## 6. 变更汇总

| 变更 | 类型 | 影响 |
|---|---|---|
| Metadata Budget 移到 ShotPool 之前 | 位置调整 | ShotPool 不再有半成品 |
| 删除 prompt-parser.mjs | 模块删除 | 减少 1 个模块，减少 19 条正则规则 |
| tags 从 Metadata Import 直通 ShotPool | 数据流修正 | Validator 不再输出 tags |
| ValidationResult 删除 tags 字段 | 字段删除 | Validator 职责更纯粹 |
| ValidationResult 删除 metrics 字段 | 字段删除 | 不需要返回每层耗时（YAGNI） |
| 增加 Reject → Accept Override | 功能增加 | 废片桶加 1 个按钮 + 3 个字段 |
| 不增加 Accept → Reject Override | 明确不做 | 现有 Review 覆盖 |
| 不增加 Artifact Location | 明确不做 | 拒绝理由已足够 |
| Slot 删除 brandColorPalette | 字段删除 | 减少色彩匹配复杂度 |

### 模块数量变化

| 之前 | 之后 |
|---|---|
| ai-video-validator.mjs | ai-video-validator.mjs（精简） |
| prompt-parser.mjs | **删除** |
| ai-ingest.mjs | ai-ingest.mjs（加 3 行 JSON 读取） |
| metadata-budget.mjs | metadata-budget.mjs（位置前移） |
| shot-scheduler.mjs | shot-scheduler.mjs（Slot 删 1 字段） |
| review-queue.mjs | review-queue.mjs（加 override 按钮） |

**净变化：-1 模块，-2 字段，+1 功能（override），+3 行代码（JSON 读取）。**

---

## 7. 最终架构图

```
═════════════════════════════════════════════════════
  REAL FOOTAGE PIPELINE (V2, 不动)
═════════════════════════════════════════════════════

  人工拍摄 → 文件夹 + 标签卡 + 一镜一动作
                    │
                    ▼
  Ingest (代码) → ffmpeg scene+tech → Shot
                    │
                    ▼
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
              ShotPool (共享)
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
                    │
                    ▼
  Scheduler (Tag+Slot) → RenderPlan → Renderer → Review
                    │                                 │
                    │                          不满意 → 改 slot → 重渲染
                    │
═════════════════════════════════════════════════════
  AI FOOTAGE PIPELINE (精简后)
═════════════════════════════════════════════════════

  AI 生成平台输出: video.mp4 + metadata.json
  (tags 由生成平台提供, 本系统不解析 Prompt)
                    │
                    ▼
  Metadata Import (3 行代码读 JSON)
    → tags + videoPath + duration
                    │
          ┌─────────┘
          │
          ▼
  Validator (3 层 cascade, 纯质量门禁)
    L1: Technical (ffmpeg, <1s)
    L2: Temporal (code, <5s)
    L3: Artifact (AI, 10-30s)
    → accept / reject / review
          │           │          │
          │           │          └→ RejectBin
          │           │                ↓
          │           │          [Override Accept]
          │           │                ↓
          ▼           ▼                │
  Metadata Budget   REJECT            │
  (~1s)                               │
    productVisibility                  │
    productCentered                    │
    motionEnergy                       │
          │                            │
          ├────────────────────────────┘
          │
          ▼
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
              ShotPool (共享, 入池即完整)
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ───
                    │
                    ▼
  Scheduler (Tag+Slot) → RenderPlan → Renderer → Review
                    │                                 │
                    │                          不满意 → 改 slot → 重渲染
```

---

## 8. 三年可维护性评估

### 复杂度

| 指标 | 原方案 | 精简后 |
|---|---|---|
| 模块数 | 6（含 prompt-parser） | 5（删除 prompt-parser） |
| Shot 字段 | 10（7+origin+3 缓存） | 10（不变，但缓存字段在入池前就绪） |
| Slot 字段 | 9（含 brandColorPalette） | 8（删除 brandColorPalette） |
| Validator 层数 | 4 层 + 灰区 | 3 层 + 灰区（V2 已删 Layer 4） |
| AI 调用点 | 1（Validator L3） | 1（不变） |
| 跨模块数据流 | 3 处有越界 | 0 处越界 |
| 需要补偿逻辑的场景 | 2（ShotPool 半成品 + prompt 解析失败） | 0 |

### 可维护性检查清单

| 检查项 | 状态 |
|---|---|
| 每个模块只做一件事 | ✅ 修正后全部满足 |
| 模块间无越界 | ✅ tags 直通，Validator 不碰 |
| ShotPool 数据始终完整 | ✅ Metadata Budget 在入池前 |
| 无补偿逻辑 | ✅ 不需要启动时扫描不完整 Shot |
| 无正则规则需要维护 | ✅ 删除 prompt-parser |
| 无品牌知识泄漏到 Validator | ✅ brandColorPalette 删除 |
| Crash Recovery 简单 | ✅ 重跑即可，无中间状态 |
| 新人 1 天能理解全部流程 | ✅ 5 个模块，每个职责一句话说清 |

### 如果三年后需要扩展

| 扩展需求 | 改动范围 | 是否需要动现有模块 |
|---|---|---|
| 新增 AI 平台 | Metadata Import 加 1 个 if 分支 | ❌ 不动其他模块 |
| 新增 Slot 类型 | Scheduler 加 1 个 Slot 定义 | ❌ 不动其他模块 |
| 新增 Artifact 检测类型 | Validator L3 加 1 个检测函数 | ❌ 不动其他模块 |
| 调整 Artifact 阈值 | Validator 配置文件改 1 个数字 | ❌ 不动代码 |
| 支持 Artifact Location | ValidationResult artifacts 加可选字段 | ⚠️ 需改 L3 模型 + UI |
| 支持色彩匹配 | Metadata Budget 加 dominantColor + Slot 加 preferredColor | ⚠️ 需改 2 模块 |

**前 4 个扩展场景不需要动现有代码。** 后 2 个需要改动，但都是增量添加字段，不是重构。这就是收敛设计的价值。

---

## 9. 一句话总结

**删掉 Prompt Parser，Metadata Budget 前移，Validator 不碰 tags，Slot 删掉 brandColorPalette，废片桶加 Override 按钮。**

5 个模块，0 越界，0 补偿逻辑，0 正则规则。三年后接手的人一天就能看懂。
