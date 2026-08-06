# Shot Pool Pipeline — Design Review（推翻版）

> 日期：2026-08-05
> 角色：Staff Engineer, Ad Tech
> 目标：推翻原方案，以「广告产能最高」为唯一北极星重新设计
> 规模假设：500 批次/天，10000 视频/天，10 Worker，3 GPU，多名设计师

---

## 判决摘要

**原方案是一个精心设计的 AI 演示项目，不是一个广告生产系统。**

它把「AI 能做的事情」当作了设计的起点，而不是把「广告素材怎么最快产出」当作起点。17 维 Metadata、OverallScore 加权公式、多层门禁、多样性惩罚函数——每一层都在增加复杂度，但没有任何一层直接回答：**设计师从上传到拿到成片，最短路径是什么？**

以下逐条拆解。

---

## 第一部分：哪些 AI 应该删掉？

### 判决：删掉 4 个 AI 步骤，保留 0 个 AI 在关键路径上

| AI 步骤 | 原方案耗时(单视频) | 人工替代 | 人工耗时 | 判决 |
|---|---|---|---|---|
| 产品识别 (Codex) | 30-60s | 摄影师按产品分文件夹 | 0s（零额外成本） | **删除** |
| 产品图识别 | 10-30s | 同上，文件夹即产品 | 0s | **删除** |
| 语义质量分析 (Codex) | 120-300s | 摄影师拍摄时勾选标签 | 10s/批 | **删除** |
| 灰片调色 (AI/手动) | 60-120s | 摄影统一白平衡 + LUT | 0s | **删除** |
| 技术质量检测 | — | ffmpeg 代码计算 | <1s | **保留但改代码** |

### 逐条分析

#### 1. 产品识别 — 删除

**原方案**：Codex 看视频帧，识别画面中有哪些产品，输出 ProductDetection.groups。

**问题**：这是在用 AI 「发现」摄影师已经知道的信息。摄影师把口红放在台面上，对着它拍——产品是什么，摄影师比 AI 清楚一万倍。

**替代**：拍摄时按产品分文件夹。

```
/storage/incoming/
  batch_20260805_001/
    lipstick_red_01/        ← 文件夹名 = 产品名
      front.mov
      side.mov
      detail.mov
    lipstick_red_02/
      ...
    foundation_01/
      ...
```

系统扫描文件夹结构，`文件夹名 → productId`，零 AI 调用。

**节省**：500 批次 × 平均 4 产品 × 45s Codex = **15 小时 GPU 时间/天**。3 台 GPU 满负荷跑，仅产品识别就吃掉 5 小时/台。

#### 2. 产品图识别 — 删除

同理。文件夹名就是产品名，不需要从画面里「认」。

#### 3. 语义质量分析 — 删除（这是最大的浪费）

**原方案**：对每个镜头跑 Codex，输出 cameraMotion / composition / clothingVisibility / patternVisibility / orientation / detailType / lighting / occlusion 共 8 个语义维度。

**问题**：

- 摄影师拍的时候就知道这是正面还是侧面、全身还是特写。这个信息在拍摄的那一刻就确定了。
- Codex 分析一个镜头的关键帧需要 30-60s。500 批次 × 20 视频 × 8 镜头/视频 = **80000 次 Codex 调用/天**。即使每台 GPU 并行 4 路，3 台 GPU 满负荷需要 80000 × 45s / 12 = **83 小时**。一天只有 24 小时。
- 准确率：根据之前实测，Codex 对 orientation（朝向）的判断准确率约 70-80%。一个 70% 准确率的标签，不如摄影师自己标——准确率 100%。

**替代**：拍摄规范 + 拍摄标签卡。

摄影师拍摄时，每拍完一个镜头，在手机/平板上点一下标签（3 个选项，10 秒搞定）：

```
角度:  [正面] [侧面] [背面] [特写]
动作:  [站姿] [转身] [走动] [展示]
```

这些标签直接写入 metadata，零 AI 调用，准确率 100%。

**如果摄影师不愿意做**：那就退一步——用文件夹结构编码。`front/` `side/` `detail/` 文件夹名即标签。连手机都不用掏。

#### 4. 灰片调色 — 删除

**原方案**：渲染阶段用 LUT + 可能的 AI 调色。

**问题**：不同镜头调色不一致是广告素材的常见问题。AI 调色每镜头 60s+ 且不稳定。人工调色更慢。

**替代**：摄影阶段统一设置。

- 所有机位同一白平衡预设（如 5500K）
- 所有素材套同一 LUT（已有 `slog3.cube`）
- 摄影师上岗前校准一次，之后不需要逐镜头调色

**结果**：调色从 Pipeline 里消失，变成拍摄 SOP 的一部分。

#### 5. 技术质量检测 — 保留，但改成纯代码

**原方案**：ffmpeg 计算模糊/抖动/曝光。

**判决**：保留。这是代码能做且 AI 做不更快的事情。ffmpeg laplacian 方差 < 1s/镜头，零 GPU 占用。

但简化输出：不需要 `blurScore` / `stabilityScore` / `exposureScore` 三个分数。只需要一个布尔值：`reject: true/false` + `rejectReason`。

---

## 第二部分：Shot Pool Metadata 是否设计过重？

### 判决：严重过重。17 维 → 5 维。

### 原方案 17 个字段分析

| 字段 | 调度器是否使用 | 判决 |
|---|---|---|
| id | 是（唯一标识） | **保留** |
| productId | 是（按产品分组调度） | **保留** |
| sourceFileId | 是（多样性约束） | **保留**（合并到 source） |
| sourcePath | 是（渲染时读取文件） | **保留** |
| sourceFileName | 否（仅 UI 展示） | 删除（可从 path 推导） |
| startTime | 是（渲染提取） | **保留** |
| endTime | 是（渲染提取） | **保留** |
| duration | 是（Slot 时长匹配） | **保留** |
| blurScore | 否（只在 reject 时用） | 删除（用 reject 布尔值替代） |
| stabilityScore | 否 | 删除 |
| exposureLevel | 否 | 删除 |
| exposureScore | 否 | 删除 |
| cameraMotion | 极少（仅 hook slot 可能用） | 删除（用 tag 替代） |
| composition | 是（Slot 匹配） | **降级为 tag** |
| clothingVisibility | 否（reject 时用） | 删除（用 reject 替代） |
| patternVisibility | 否 | 删除 |
| orientation | 是（Slot 匹配） | **降级为 tag** |
| detailType | 是（detail slot 匹配） | **降级为 tag** |
| lighting | 否 | 删除 |
| occlusion | 否（reject 时用） | 删除（用 reject 替代） |
| hookPotential | 是（hook slot） | 删除（hook 是 tag，不是分数） |
| overallScore | 是（排序） | **删除**（见第三部分） |
| rejected | 是（过滤） | **保留** |
| rejectReason | 否（仅 UI） | **保留**（调试用） |
| detectedAt | 否 | 删除 |
| analyzedAt | 否 | 删除 |
| representativeFramePath | 否（UI） | 删除（按需生成） |

### 精简后的 Shot

```typescript
type Shot = {
  id: string;           // UUID
  source: string;       // "batch_001/lipstick_red" — 产品+批次标识
  path: string;         // 源视频路径
  start: number;        // 起始秒
  end: number;          // 结束秒
  duration: number;     // 时长
  tags: string[];       // ["front", "full_body", "hook"] — 人工标注
  reject: boolean;      // 技术门禁拒绝
  rejectReason?: string; // "blur" | "exposure" | "unstable"
};
```

**5 个核心字段 + 2 个状态字段 = 7 个。从 17 降到 7。**

被删除的 10 个字段：
- 6 个技术分数 → 合并为 1 个 `reject` 布尔值
- 4 个语义维度 → 降级为 `tags` 数组里的字符串

---

## 第三部分：不要 OverallScore，用 Tag + Slot

### 判决：Tag + Slot 方案明确更优。原方案的 OverallScore 是整个设计最大的架构错误。

### 为什么 OverallScore 是错的

**广告没有统一评分标准。**

一段 0.5 秒的快速推镜特写，作为 Hook 是满分，作为 Body 是零分。
一段 3 秒的稳定全身站姿，作为 Body 是满分，作为 Hook 是零分。

用同一个 `overallScore` 排序所有镜头，等于假设所有镜头在所有位置上的价值相同——这在广告里不成立。

原方案的 `hookPotential` 字段已经是对这个问题的承认——如果 OverallScore 真的够用，就不需要单独算 hookPotential。但加了 hookPotential 之后，又出现了 `detailPotential`、`bodyPotential` 的需求。这条路走下去就是每个 Slot 一个分数，那 OverallScore 就完全没用了。

### Tag + Slot 方案

**Shot 只有：**
```typescript
{
  tags: ["front", "full_body", "hook"],
  duration: 3.2,
  source: "batch_001/lipstick_red",
  reject: false
}
```

**Script Template 只有 Slot：**
```typescript
type Slot = {
  name: string;           // "hook" | "body" | "detail" | "back" | "closing"
  duration: number;       // 目标时长
  requireTags: string[];  // ["front", "full_body"]
  rejectTags?: string[];  // ["blur", "occluded"]
  minDuration: number;    // 最短可用
  maxDuration: number;    // 最长可用
};
```

**调度器逻辑（纯代码，< 1ms）：**
```
对每个 slot:
  候选 = ShotPool 中所有 shots
    where reject == false
    and requireTags.every(tag => shot.tags.includes(tag))
    and not rejectTags.some(tag => shot.tags.includes(tag))
    and minDuration <= shot.duration <= maxDuration
    and source 不在最近 N 个已选的 source 中（多样性硬约束）
  
  if 候选.length == 0:
    放宽：去掉最近 N 个 source 约束
  if 候选.length == 0:
    放宽：去掉 requireTags 中最后一个 tag
  if 候选.length == 0:
    标记 slot 为 "缺素材" → 人工处理
  
  从候选中随机选一个（或按 source 使用次数最少的优先）
```

### Tag + Slot 的优势

| 维度 | OverallScore 方案 | Tag + Slot 方案 |
|---|---|---|
| 透明度 | 设计师看 87 分不知道为什么没用 | 设计师看 `["front","full_body"]` 匹配不上立刻知道缺什么 |
| 可调试 | 改加权系数 → 重新计算 → 重新调度 | 加/删一个 tag → 重新调度（< 1ms） |
| 可控性 | 只能调分数阈值 | 可以精确控制「这个 slot 只用正面全身」 |
| AI 依赖 | 需要 AI 算分 | 零 AI |
| 失败模式 | 分数 85 但视觉平淡，无法定位 | tag 匹配是确定性的，对就对，不对就不对 |
| 新增镜头类型 | 需要重新定义评分维度 | 加一个 tag 字符串即可 |

---

## 第四部分：Scene Detection 是否合理？

### 判决：ffmpeg Scene Detection 对这个场景不够用，但不能怪 ffmpeg——是拍摄方式的问题。

### 问题根源

广告拍摄常见模式：一个机位，模特连续做正面→侧面→背面→转身→细节，一镜到底。

ffmpeg `select=gt(scene,0.3)` 检测的是帧间差异超过阈值。但正面→侧面是一个平滑过渡，帧间差异可能不超过 0.1。结果：一个 15 秒的连续镜头被识别为 1 个 scene，但实际包含 5 个可用片段。

原方案的缓解方案是「设两级阈值 + Codex 确认边界」——这又把 AI 拉回来了，而且两级阈值的调参本身就是噩梦。

### 正确方案：拍摄规范 — 一镜一动作

**规则**：摄影师每拍完一个动作/角度，用手遮一下镜头或暂停 1-2 秒。

**效果**：
- 遮镜头 → 帧间差异巨大（从人脸跳到全黑）→ ffmpeg scene detection 100% 命中
- 每个 scene 恰好是一个动作/角度
- 零 AI，零调参，< 1s 检测

**为什么这个方案更好**：
1. 把复杂度从后处理（贵）移到了拍摄（便宜）
2. 摄影师遮镜头是 1 秒的动作，比后期 AI 切分快 300 倍
3. 切分精度 100%，不依赖任何阈值
4. 摄影师本身就需要在动作之间停顿（换姿势/换角度），遮镜头只是把这个停顿显式化

**如果素材已经拍完了（不符合规范）**：
- 提供一个简单的 Web 端手动切分工具（拖拽时间轴打点，5 秒/视频）
- 这比跑 AI 切分快得多，而且 100% 准确
- 对于 10000 视频/天的规模，手动切分不现实——但这恰好说明应该推行拍摄规范

---

## 第五部分：如何让 Pipeline 更快？

### 判决：原 Pipeline 12 步 → 新 Pipeline 4 步。后处理耗时减少 85%+。

### 原方案 Pipeline（12 步）

```
[1]  样片分析 (Codex)           2-5 min
[2]  产品识别 (Codex)            30-60s × N产品
[3]  Proxy 转码 (ffmpeg)         10-30s
[4]  镜头切分 (ffmpeg)           < 1s/视频
[5]  技术质量门禁 (ffmpeg)        1-3s/镜头
[6]  语义质量分析 (Codex)        30-60s/镜头 ← 瓶颈
[7]  综合评分 + 拒绝 (代码)       < 1s
[8]  脚本模板配置                < 1s
[9]  调度器选镜 (代码)            < 1s
[10] EDL 转换 (代码)             < 100ms
[11] 渲染 (ffmpeg)              30-120s/产品
[12] 审核/交付                    人工
```

**后处理总耗时（单批次 20 视频）**：约 40-60 分钟，其中 AI 占 70%+

### 删除的步骤

| 步骤 | 删除原因 | 替代方案 |
|---|---|---|
| [1] 样片分析 (Codex) | 样片分析产出的 ReferenceProfile 是为了给 Codex 选镜用的。如果不靠 AI 选镜，就不需要 AI 分析样片 | 人工选 1 个样片 → 人工写 Slot 模板（10 分钟，一次写好复用） |
| [2] 产品识别 (Codex) | 文件夹结构已知 | 文件夹扫描 |
| [6] 语义质量分析 (Codex) | 标签人工给 | 拍摄标签卡 |
| [7] 综合评分 | 不需要分数 | Tag 匹配 |
| [8] 脚本模板配置（自动生成） | 不需要从样片自动生成 | 人工预设模板库 |

### 合并的步骤

| 原步骤 | 合并后 |
|---|---|
| [4] 镜头切分 + [5] 技术质量 | 合并为一次 ffmpeg pass：scene detection + ffprobe 技术检测同时跑 |

### 前移到拍摄阶段的步骤

| 原步骤 | 前移到 |
|---|---|
| 产品识别 | 拍摄时分文件夹 |
| 语义分析 | 拍摄时勾选标签 |
| 调色 | 拍摄时统一白平衡 + LUT |
| 样片分析 | 设计师人工写 Slot 模板（一次性） |

### 新 Pipeline（4 步后处理）

```
拍摄阶段（人工，零系统耗时）
  ├── 按产品分文件夹
  ├── 一镜一动作（遮镜头分隔）
  ├── 拍摄标签卡（10s/批）
  └── 统一白平衡 + LUT

后处理阶段（系统，全自动）
  [1] 入池（代码，< 2s/视频）
      ├── 文件夹扫描 → 提取 source / tags
      ├── ffmpeg scene detection → 切分镜头
      └── ffmpeg 技术检测 → reject 标记
  [2] 调度（代码，< 100ms/批）
      └── Tag + Slot 匹配 → RenderPlan
  [3] 渲染（ffmpeg，30-120s/产品）
      └── concat + 音乐卡点 + 字幕
  [4] 交付（现有逻辑）

审核阶段（人工）
  └── 设计师看成片 → 满意/要求改
```

### 耗时对比

| 阶段 | 原方案 | 新方案 | 减少 |
|---|---|---|---|
| 样片分析 | 2-5 min | 0（预设模板） | 100% |
| 产品识别 | 2-4 min | 0（文件夹） | 100% |
| 镜头切分 | 1-2 min | < 30s | 75% |
| 技术检测 | 3-5 min | 合并到切分 | 100% |
| 语义分析 | 8-15 min | 0（人工标签） | 100% |
| 评分 | < 10s | 0（无分数） | 100% |
| 调度 | < 1s | < 100ms | — |
| 渲染 | 30-120s | 30-120s（不变） | 0% |
| **单批次总计** | **~40-60 min** | **~3-5 min** | **~90%** |

**每天 500 批次**：
- 原方案：500 × 50min = 25000 min = **416 小时**（需要 18 条并行流水线才能在 24 小时内跑完）
- 新方案：500 × 4min = 2000 min = **33 小时**（2 条并行流水线即可，10 台 Worker 绑绑有余）

---

## 第六部分：全新 Pipeline 设计

### 设计原则

1. **AI 只做 AI 真正擅长的事**：在这个系统里，AI 唯一可能的价值是……实际上没有。所有步骤都有更快更准的非 AI 替代方案。
2. **代码只做规则**：Tag 匹配、时长过滤、多样性约束——全是确定性逻辑，< 1ms。
3. **人工只做几秒钟能完成的事**：分文件夹（0s）、遮镜头（1s）、勾标签（10s/批）。
4. **零 AI 在关键路径上**：Codex 不参与批次处理。如果要用 Codex，只用于离线的模板优化/质量抽检，不阻塞生产。

### 完整新 Pipeline

```
═══════════════════════════════════════════
  CAPTURE — 拍摄阶段（人工，零系统耗时）
═══════════════════════════════════════════

  摄影师 SOP:
  1. 按产品建文件夹: /batch_id/product_name/
  2. 每个动作一镜，动作间遮镜头 1-2 秒
  3. 统一白平衡 5500K + slog3 LUT
  4. 每拍完一批，在标签卡上勾选:
     角度: [front] [side] [back] [detail]
     构图: [full_body] [upper_body] [close_up]
     用途: [hook] [body] [transition]
     → 10 秒/批，写入 tags.json

═══════════════════════════════════════════
  INGEST — 入池（代码，全自动）
═══════════════════════════════════════════

  Worker 接收到新批次:
  1. 扫描文件夹结构
     → source = "batch_id/product_name"
     → 从 tags.json 读取人工标签

  2. ffmpeg scene detection（一镜一动作 → 精确切分）
     → 每个 scene = 一个 Shot
     → shot.start / shot.end / shot.duration

  3. ffmpeg 技术检测（与切分同一 pass）
     → laplacian 方差 < 阈值 → reject("blur")
     → 帧间运动 > 阈值 → reject("unstable")
     → 直方图偏移 → reject("exposure")

  4. 写入 ShotPool:
     shot-pool.json = {
       shots: [{ id, source, path, start, end, duration, tags, reject, rejectReason }]
     }

  耗时: < 2s/视频
  AI 调用: 0
  GPU 占用: 0

═══════════════════════════════════════════
  SCHEDULE — 调度（代码，全自动）
═══════════════════════════════════════════

  调度器读取:
  - ShotPool（镜头池）
  - ScriptTemplate（Slot 列表，人工预设）

  对每个产品:
    对脚本的每个 slot:
      1. 筛选: reject==false && tags 包含 requireTags && 时长匹配
      2. 多样性: source 不在最近 3 个已选 source 中
      3. 候选为空 → 逐步放宽约束
      4. 候选仍为空 → 标记 slot "缺素材"
      5. 从候选中选 source 使用次数最少的

  输出: RenderPlan（= EDL）

  耗时: < 100ms/批
  AI 调用: 0

═══════════════════════════════════════════
  RENDER — 渲染（ffmpeg，全自动）
═══════════════════════════════════════════

  复用现有 batch-renderer.mjs:
  - ffmpeg concat 拼接镜头
  - 音乐卡点对齐
  - 字幕/CVR 叠加
  - 质检

  耗时: 30-120s/产品
  AI 调用: 0

═══════════════════════════════════════════
  REVIEW — 审核（人工）
═══════════════════════════════════════════

  设计师看成片:
  - 满意 → 交付
  - 不满意 → 调整 Slot 模板 / 在 ShotPool 里加/删 tag
    → 重新调度（< 100ms）→ 重新渲染

  迭代耗时: < 2 分钟（vs 原方案 20 分钟+）
```

### 保留哪些模块

| 模块 | 保留/删除 | 原因 |
|---|---|---|
| `batch-renderer.mjs` | **保留** | ffmpeg 渲染逻辑不变 |
| `lib/store.ts` | **保留** | 批次存储不变 |
| `lib/atomic-json.mjs` | **保留** | 原子写入不变 |
| `delivery-watcher.mjs` | **保留** | 交付流程不变 |
| `chatcut-sync.mjs` | **保留** | ChatCut 同步不变 |
| `template-processor.mjs` | **保留** | 模板处理不变 |
| `processor.mjs` | **大改** | 删除所有 Codex 调用，替换为文件夹扫描 + ffmpeg 切分 + 代码调度 |
| `app/page.tsx` | **改** | Shot Pool 面板改为 tag 视图，新增「缺素材」提示 |
| 新增 `shot-detector.mjs` | **新增** | ffmpeg scene detection + 技术检测（合并为一次 pass） |
| 新增 `shot-scheduler.mjs` | **新增** | Tag + Slot 匹配调度器 |

### 删除哪些模块

| 模块 | 删除原因 |
|---|---|
| `shot-quality-semantic.mjs` | 语义分析改为人工标签，不需要 AI |
| `shot-quality-tech.mjs`（独立模块） | 合并到 shot-detector.mjs，不需要单独模块 |
| Codex 调用（样片分析） | 改为人工预设 Slot 模板 |
| Codex 调用（产品识别） | 改为文件夹扫描 |
| Codex 调用（语义分析） | 改为人工标签 |
| Codex 调用（选镜/EDL） | 改为代码调度器 |
| OverallScore 计算 | 不需要分数 |
| DiversityConfig + sourcePenalty | 简化为「最近 3 个 source 不重复」硬约束 |
| Pipeline 模式切换（legacy vs shot_pool） | 新系统只有一条 Pipeline |

### 为什么删除

| 删除项 | 理由 |
|---|---|
| 全部 Codex 调用 | 10000 视频/天 × 3-5 Codex 调用/视频 = 30000-50000 次/天。3 台 GPU 不可能跑完。而且每个替代方案都更快更准。 |
| 17 维 Metadata | 调度器实际只用 5 个字段。其余 12 个是「为了完整而设计」，不参与任何决策。 |
| OverallScore | 广告没有统一评分。Tag + Slot 匹配更透明、更可控、更快。 |
| 两级 scene detection 阈值 + Codex 确认 | 拍摄规范（一镜一动作）让切分变成 ffmpeg 100% 命中的简单操作。 |
| 样片分析 | 人工写一次 Slot 模板（10 分钟），复用到天荒地老。不需要每次批次都分析。 |
| Pipeline 模式切换 | 只有一条 Pipeline，不需要切换逻辑、不需要兼容旧路径。 |

### 预计提升

| 指标 | 原方案 | 新方案 | 提升 |
|---|---|---|---|
| 单批次后处理耗时 | 40-60 min | 3-5 min | **~90%** |
| 每日 AI 调用次数 | ~30000+ | **0** | **100%** |
| GPU 占用 | 3 台满负荷（不够） | 0 台 | **100%** |
| 调度耗时 | < 1s | < 100ms | — |
| 修订迭代耗时 | 20 min+（重新跑 Codex） | < 2 min（改 tag → 重新调度 → 重新渲染） | **~90%** |
| 10 Worker 日产能 | ~240 批次（受 GPU 限制） | **500+ 批次**（受 ffmpeg 限制，10 Worker 绰绰有余） | **~2×** |
| 可维护模块数 | 5 新模块 + 兼容层 | 2 新模块 | **~60%** |
| 代码行数（新增） | ~2000+ 行 | ~500 行 | **~75%** |

### 最终目标对齐

| 目标 | 原方案 | 新方案 |
|---|---|---|
| AI 自动化率 | ~70%（高但不可靠） | **0%**（不追求 AI 自动化） |
| 广告产能 | 受 GPU 限制，~240 批/天 | **500+ 批/天**，不受 GPU 限制 |
| 稳定性 | 依赖 Codex 可用性（已知会超限） | **纯代码，零外部依赖** |
| 可维护性 | 5 模块 + 17 维 + 评分公式 + 兼容层 | **2 模块 + 7 字段 + tag 匹配** |
| 设计师体验 | 黑盒分数 + 20 分钟改一次 | **白盒 tag + 2 分钟改一次** |

---

## 结论

原方案的核心错误是：**把 AI 当作了系统的骨架，而不是可选的肌肉。**

当你把 AI 从骨架里抽掉，整个系统反而更清晰了：

- 拍摄时人工分文件夹 + 勾标签 → 零成本，100% 准确
- ffmpeg 切分 + 技术检测 → < 2s/视频，零 GPU
- 代码调度器做 Tag + Slot 匹配 → < 100ms/批，确定性
- ffmpeg 渲染 → 现有逻辑不变

**AI 在这个系统里的正确定位是：离线工具。**

比如：每周用 Codex 抽检 50 个成片，分析「哪些 tag 组合产出的成片设计师满意度最高」→ 优化 Slot 模板。这不阻塞生产，不占 GPU，不引入不稳定性。

生产路径上，一行 AI 都不要有。
