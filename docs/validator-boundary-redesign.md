# Validator 职责收窄 — Quality Gate / ShotPool / Scheduler 三权分立

> 日期：2026-08-05
> 角色：Staff Engineer, Ad Tech
> 前提：Dual Pipeline Architecture（dual-pipeline-architecture.md）保留，本文档仅重新划分 Validator 边界
> 原则：每个模块只负责一件事。Validator 不评价创意，不评价 CTR，不评价 Prompt，不给生成建议。

---

## 0. 问题诊断

当前 Validator（dual-pipeline-architecture.md §2）的 Layer 4 "Ad Suitability" 包含四个检测项：

| 检测项 | 当前归属 | 问题 |
|---|---|---|
| Product Visibility < 80% | Validator Layer 4 | 生活场景镜头产品可见 40% 是正常的，不算废片。这是 Slot 匹配条件，不是质量门禁 |
| Composition（产品在安全区） | Validator Layer 4 | 特写产品细节不需要产品居中。构图适配取决于用在哪 |
| Hook Potential（前 0.5s 动态） | Validator Layer 4 | "适合做 Hook 吗"是创意判断。一个慢推镜做 Detail 是满分，做 Hook 是零分 |
| Brand Color Mismatch | Validator Layer 4 | 需要 brand 知识。Validator 不应该知道品牌色是什么 |

当前 AI Artifact Taxonomy（§1）的 Brand Artifact 分类包含：

| 子类 | 问题 |
|---|---|
| product_visibility | 广告适配判断，非质量缺陷 |
| product_occluded | 同上 |
| composition_poor | 构图判断，非质量缺陷 |
| text_artifact | ✅ 保留——AI 乱码文字是技术缺陷 |
| brand_color_mismatch | 需要 brand 知识，非质量缺陷 |

**根因：Validator 混淆了两件事——"视频是否有技术缺陷"和"视频是否适合某个广告用途"。**

前者是质量门禁（客观的，与用途无关）。后者是创意决策（主观的，取决于 Slot 上下文）。

---

## 1. 三权分立

### 1.1 职责定义

```
┌─────────────────────────────────────────────────────┐
│  Quality Gate (Validator)                           │
│                                                     │
│  问题: 这个视频是否有技术缺陷?                        │
│  回答: accept / reject / review                     │
│  知识: 只知道视频文件本身。不知道广告脚本、           │
│        Slot、品牌色、Hook/Body/Detail。              │
│  动作: 无缺陷 → 放入 ShotPool                       │
│        有缺陷 → 进废片桶                             │
│        灰区 → 进人工审核队列                         │
│                                                     │
│  规则: 一个视频要么能进 ShotPool，要么不能。          │
│        这个判断与"用在哪"无关。                       │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  ShotPool                                           │
│                                                     │
│  问题: (不问问题，只是存储)                          │
│  内容: 所有通过 Quality Gate 的 Shot                 │
│  属性: id / source / path / duration / tags /        │
│        reject / origin                              │
│  规则: ShotPool 里的每一个 Shot 都是"可用的"。        │
│        不存在"好"或"坏"——只有"标签不同"。            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Scheduler                                          │
│                                                     │
│  问题: 哪个 Shot 适合哪个 Slot?                      │
│  回答: RenderPlan (Shot → Slot 映射)                │
│  知识: 知道广告脚本、Slot 需求、品牌规范、            │
│        产品可见度要求、Hook/Body/Detail 适配性。      │
│  动作: Tag + Slot 匹配 → 选出最适合的 Shot           │
│        某个 Shot 不适合 Slot 3 → 不选它（但不从      │
│        ShotPool 删除）                               │
│                                                     │
│  规则: 一个 Shot 可以"不适合 Slot 3"但仍然            │
│        在 ShotPool 里等别的 Slot 选它。              │
└─────────────────────────────────────────────────────┘
```

### 1.2 核心区分原则

| 维度 | Quality Gate | Scheduler |
|---|---|---|
| 问的问题 | 视频有缺陷吗? | 视频适合这个位置吗? |
| 判断依据 | 视频文件本身 | 视频 + 广告脚本 + Slot 需求 |
| 结果 | 二选一：进 ShotPool / 不进 | 多选一：从 ShotPool 里挑最合适的 |
| 可逆性 | 不可逆（废片就是废片） | 可逆（不适合 Slot 3 但可能适合 Slot 5） |
| 是否需要品牌知识 | 否 | 是 |
| 是否知道 Hook/Body/Detail | 否 | 是 |
| 是否评价创意 | **绝不** | 这就是它的核心工作 |

### 1.3 一个具体例子

一段 AI 视频：模特从远处走向产品，拿起产品展示。产品在前 3 秒不可见，后 2 秒可见。

| 模块 | 判断 | 理由 |
|---|---|---|
| Quality Gate | ✅ accept | 视频无技术缺陷。人物正常，产品正常，无 artifact |
| ShotPool | 存入，tags: ["full_body", "tracking", "lifestyle"] | 可用镜头 |
| Scheduler (Slot: Hook) | ❌ 不选 | Hook 需要 0-1s 有冲击力，这段前 3 秒是走路，产品不可见 |
| Scheduler (Slot: Body) | ✅ 可能选 | Body 可以容纳叙事性镜头，产品在后半段展示 |
| Scheduler (Slot: Detail) | ❌ 不选 | Detail 需要产品特写，这段是全身远景 |

**关键：Quality Gate 放行了，但 Hook 和 Detail 都不选它。这不意味着视频有缺陷——它只是更适合 Body。这个"适合性"判断是 Scheduler 的事，不是 Validator 的。**

---

## 2. Validator 重新设计

### 2.1 删除项

| 删除的检测项 | 原位置 | 删除理由 | 去向 |
|---|---|---|---|
| Hook Potential | Layer 4 | 创意判断，取决于 Slot 用途 | → Scheduler Slot 定义 |
| Product Visibility < 80% | Layer 4 | 广告适配判断，非质量缺陷 | → Scheduler Slot 定义 |
| Composition（产品在安全区） | Layer 4 | 构图判断，取决于 Slot 用途 | → Scheduler Slot 定义 |
| Brand Color Mismatch | Layer 4 | 需要 brand 知识 | → Scheduler Slot 定义 |
| product_visibility | Brand Artifact | 同 Product Visibility | → Scheduler |
| product_occluded | Brand Artifact | 同上 | → Scheduler |
| composition_poor | Brand Artifact | 同 Composition | → Scheduler |
| brand_color_mismatch | Brand Artifact | 同 Brand Color | → Scheduler |

### 2.2 保留项

| 保留的检测项 | 位置 | 保留理由 |
|---|---|---|
| 分辨率 / 时长 / 码率 / 帧率 | Layer 1 | 客观技术规格 |
| 全局闪烁 (global_flicker) | Layer 1 | 客观时序缺陷 |
| 纹理沸腾 (texture_boil) | Layer 2 | 客观时序缺陷 |
| 卡顿 (stutter) | Layer 2 | 客观时序缺陷 |
| 空间扭曲 (warp) | Layer 2 | 客观空间缺陷 |
| 非物理运动 (non_physical) | Layer 2 | 客观运动缺陷 |
| Camera Jump | Layer 2 | 客观空间缺陷 |
| 手指异常 (hand_anomaly) | Layer 3 | 客观人体缺陷 |
| 面部跳变 (face_drift) | Layer 3 | 客观人体缺陷 |
| 肢体异常 (limb_mutation) | Layer 3 | 客观人体缺陷 |
| 身体比例 (body_proportion) | Layer 3 | 客观人体缺陷 |
| 姿态异常 (pose_impossible) | Layer 3 | 客观人体缺陷 |
| 服装穿模 (clothing_fusion) | Layer 3 | 客观人体缺陷 |
| 眼部异常 (eye_anomaly) | Layer 3 | 客观人体缺陷 |
| 产品消失 (product_dissolution) | Layer 3 | 客观产品缺陷 |
| 产品形变 (product_deformation) | Layer 3 | 客观产品缺陷 |
| 颜色漂移 (color_drift) | Layer 3 | 客观产品缺陷 |
| Logo 不一致 (logo_inconsistent) | Layer 3 | 客观产品缺陷 |
| 比例异常 (scale_shift) | Layer 3 | 客观产品缺陷 |
| 纹理漂移 (texture_drift) | Layer 3 | 客观产品缺陷 |
| 产品背景融合 (product_bg_fusion) | Layer 3 | 客观产品缺陷 |
| 背景闪烁 (bg_flicker) | Layer 3 | 客观场景缺陷 |
| 物体凭空出现 (object_spawn) | Layer 3 | 客观场景缺陷 |
| 光照不一致 (lighting_shift) | Layer 3 | 客观场景缺陷 |
| 文字乱码 (text_artifact) | Layer 3 | 客观画面缺陷（AI 无法正确渲染文字） |

### 2.3 新的 Cascade（3 层 + 灰区）

```
Input: AI video file + generation prompt
                    │
                    ▼
    ┌─────────────────────────────────────────────┐
    │  Layer 1: Technical Pass (ffmpeg, < 1s)       │
    │                                               │
    │  检测: tech:low_resolution                     │
    │       tech:duration_invalid                    │
    │       tech:low_bitrate                         │
    │       tech:framerate_inconsistent              │
    │       tech:global_flicker                      │
    └─────────────────────────────────────────────┘
         │ Pass                    │ Fail → REJECT
         ▼
    ┌─────────────────────────────────────────────┐
    │  Layer 2: Temporal Stability (code, < 5s)     │
    │                                               │
    │  检测: tech:texture_boil                       │
    │       tech:stutter                             │
    │       motion:warp                              │
    │       motion:non_physical                      │
    │       motion:camera_jump                       │
    └─────────────────────────────────────────────┘
         │ Pass                    │ Fail → REJECT
         ▼
    ┌─────────────────────────────────────────────────┐
    │  Layer 3: Artifact Detection (AI model, 10-30s)  │
    │                                                   │
    │  3a. Human Anomaly:                               │
    │      hand_anomaly / face_drift / limb_mutation   │
    │      body_proportion / pose_impossible            │
    │      clothing_fusion / eye_anomaly               │
    │                                                   │
    │  3b. Product Defect:                             │
    │      dissolution / deformation / color_drift      │
    │      logo_inconsistent / scale_shift              │
    │      texture_drift / product_bg_fusion            │
    │                                                   │
    │  3c. Scene Defect:                               │
    │      bg_flicker / object_spawn / lighting_shift   │
    │      text_artifact (AI 乱码文字)                  │
    │                                                   │
    │  判定: 置信度 > 0.85 → REJECT                     │
    │        置信度 < 0.5 → PASS                        │
    │        0.5-0.85 → 灰区 (Human Review)             │
    └─────────────────────────────────────────────────┘
         │ Pass      │ Fail → REJECT    │ Gray → Human Review
         ▼
    ACCEPT → ShotPool
```

**Layer 4 已删除。Validator 不再有 Ad Suitability 层。**

### 2.4 精简后的 RejectReason 编码

```typescript
type RejectReason =
  // Layer 1: Technical (ffmpeg)
  | "tech:low_resolution"
  | "tech:duration_invalid"
  | "tech:low_bitrate"
  | "tech:framerate_inconsistent"
  | "tech:global_flicker"
  // Layer 2: Temporal (code)
  | "tech:texture_boil"
  | "tech:stutter"
  | "motion:warp"
  | "motion:non_physical"
  | "motion:camera_jump"
  // Layer 3: Human (AI model)
  | "human:hand_anomaly"
  | "human:face_drift"
  | "human:limb_mutation"
  | "human:body_proportion"
  | "human:pose_impossible"
  | "human:clothing_fusion"
  | "human:eye_anomaly"
  // Layer 3: Product (AI model)
  | "product:dissolution"
  | "product:deformation"
  | "product:color_drift"
  | "product:logo_inconsistent"
  | "product:scale_shift"
  | "product:texture_drift"
  | "product:bg_fusion"
  // Layer 3: Scene (AI model)
  | "scene:bg_flicker"
  | "scene:object_spawn"
  | "scene:lighting_shift"
  | "scene:text_artifact"
  // Gray zone
  | "review:low_confidence";
```

**对比原设计：删除了 `brand:product_visibility` / `brand:composition` / `brand:text_artifact` / `brand:color_mismatch` 四个编码。**

`text_artifact` 从 `brand:` 前缀改为 `scene:` 前缀——AI 生成的乱码文字是画面缺陷，不是品牌问题。

### 2.5 AI Artifact Taxonomy 精简

**删除 Brand Artifact 整个分类。**

```
AI Artifact Taxonomy (精简后)
├── 1. Human Artifact（人物异常）
│   ├── hand_anomaly
│   ├── face_drift
│   ├── limb_mutation
│   ├── body_proportion
│   ├── pose_impossible
│   ├── clothing_fusion
│   └── eye_anomaly
│
├── 2. Product Artifact（产品缺陷）
│   ├── dissolution
│   ├── deformation
│   ├── color_drift
│   ├── logo_inconsistent
│   ├── scale_shift
│   ├── texture_drift
│   └── product_bg_fusion
│
├── 3. Scene Artifact（画面缺陷）
│   ├── bg_flicker
│   ├── texture_boil
│   ├── object_spawn
│   ├── lighting_shift
│   └── text_artifact       ← 从 Brand 类移入
│
├── 4. Motion Artifact（运动异常）
│   ├── non_physical
│   ├── camera_jump
│   └── warp
│
└── 5. Temporal Artifact（时序异常）
    ├── frame_stutter
    ├── global_flicker
    └── temporal_boiling

※ Brand Artifact 分类已删除。
  原有的 product_visibility / composition / brand_color
  全部移至 Scheduler 的 Slot 定义。
```

**5 大类，27 子类（原 6 大类 30+ 子类）。**

---

## 3. ShotPool（不变）

ShotPool 完全不变。V2 的 7 字段 schema 保持原样：

```typescript
type Shot = {
  id: string;
  source: string;
  path: string;
  start: number;
  end: number;
  duration: number;
  tags: string[];
  reject: boolean;
  rejectReason?: string;
  origin: "real" | "ai";
};
```

ShotPool 里的每一个 Shot 都是"通过质量门禁的可用镜头"。不存在"质量不好"的 Shot——只存在"标签不同"的 Shot。

---

## 4. Scheduler 增强

### 4.1 原 Scheduler 的问题

V2 的 Scheduler 只做 Tag + Slot 匹配：

```
Slot { requireTags: ["close_up", "detail"] }
→ 从 ShotPool 找 tags 包含这些的 Shot
```

这是纯标签匹配，没有考虑广告适配性。**原方案把广告适配性塞进了 Validator Layer 4，而不是放在 Scheduler 里。** 现在要把它移回来。

### 4.2 Slot 定义增强

```typescript
type Slot = {
  // --- 原有（V2 不变） ---
  id: string;
  label: string;                    // "Hook" / "Body" / "Detail"
  requireTags: string[];            // 必须包含的 tag
  preferTags?: string[];            // 优先选择但不强制
  minDuration?: number;             // 最短时长
  maxDuration?: number;             // 最长时长

  // --- 新增（从 Validator Layer 4 移入）---
  minProductVisibility?: number;     // 产品最低可见时间百分比
  requireProductCentered?: boolean;  // 产品是否需要在画面中心区域
  requireMotionEnergy?: "high" | "medium" | "low";  // 运动能量要求
  brandColorPalette?: string[];      // 品牌色（可选，用于色彩匹配）
};
```

### 4.3 Slot 类型示例

```typescript
const HOOK_SLOT: Slot = {
  id: "hook",
  label: "Hook",
  requireTags: ["hook"],             // 需要有 hook tag（来自 prompt "dynamic"）
  minDuration: 0.5,
  maxDuration: 2.0,
  // 从 Validator 移入的创意判断 ↓
  minProductVisibility: 80,           // Hook 产品必须高可见
  requireMotionEnergy: "high",        // Hook 需要高运动能量
};

const BODY_SLOT: Slot = {
  id: "body",
  label: "Body",
  requireTags: [],
  minDuration: 2.0,
  maxDuration: 5.0,
  // 从 Validator 移入的创意判断 ↓
  minProductVisibility: 40,           // Body 允许叙事，产品可以低可见
  requireMotionEnergy: "medium",
};

const DETAIL_SLOT: Slot = {
  id: "detail",
  label: "Detail",
  requireTags: ["close_up"],          // Detail 需要特写
  minDuration: 1.0,
  maxDuration: 3.0,
  // 从 Validator 移入的创意判断 ↓
  minProductVisibility: 90,            // Detail 产品必须满屏
  requireProductCentered: true,        // Detail 产品需居中
  requireMotionEnergy: "low",          // Detail 通常稳定
};
```

### 4.4 Scheduler 匹配流程

```
对每个 Slot:
  1. 从 ShotPool 筛选 requireTags 全部匹配的 Shot
  2. 过滤 duration 不在 [min, max] 范围的
  3. [新增] 过滤 minProductVisibility 不达标的
  4. [新增] 过滤 requireProductCentered 不满足的
  5. [新增] 过滤 requireMotionEnergy 不匹配的
  6. [新增] 如有 brandColorPalette，计算色彩匹配度排序
  7. 从剩余候选中选 preferTags 匹配最多的
  8. 应用多样性规则（同 source 不连续超过 2 次）
  9. 输出 RenderPlan
```

**关键区别：步骤 3-6 不再是 Validator 的 reject，而是 Scheduler 的"不选"。一个 Shot 不被 Slot 选中，仍在 ShotPool 里等其他 Slot 选。**

### 4.5 创意判断的计算成本

| 判断项 | 计算方式 | 耗时 | 何时计算 |
|---|---|---|---|
| minProductVisibility | 帧间产品区域检测 | ~0.5s | 入池时预算一次，缓存为 metadata |
| requireProductCentered | 产品 bbox 中心位置 | ~0.1s | 同上 |
| requireMotionEnergy | 光流幅度统计 | ~0.3s | 同上 |
| brandColorPalette 匹配 | 主色提取 + 距离计算 | ~0.1s | 调度时实时计算 |

**入池预算：每个通过 Validator 的视频额外 ~1s 计算 3 个 metadata 值，缓存到 Shot 上。Scheduler 直接读缓存，匹配 < 1ms。**

### 4.6 Shot 扩展（缓存字段）

```typescript
type Shot = {
  // ... 原有 7 字段 + origin ...
  
  // --- 新增缓存字段（入池时计算，Scheduler 读取）---
  productVisibility?: number;        // 0-100，产品可见时间百分比
  productCentered?: boolean;          // 产品是否在画面中心区域
  motionEnergy?: "high" | "medium" | "low";  // 运动能量等级
};
```

这些字段是 Scheduler 的缓存数据，不是 Validator 的判断依据。**Validator 不计算这些值——入池后的 metadata 预算步骤计算。**

流程变为：

```
Validator (3 层) → accept → 入池 → metadata 预算 (~1s) → 写入 ShotPool
                                                    ↑
                                            productVisibility / productCentered / motionEnergy
                                            在这里计算，不在 Validator 里
```

---

## 5. 完整流程对比

### 原流程

```
AI 视频 → Prompt 解析 → Validator L1 → L2 → L3 → L4 (Ad Suitability) → ShotPool → Scheduler → Render
                                                    ↑
                                              越界：创意判断在这里
```

### 新流程

```
AI 视频 → Prompt 解析 → Validator L1 → L2 → L3 → ShotPool → Metadata 预算 → Scheduler → Render
                         │  纯质量门禁  │      │           ↑                ↑
                         │  不知广告   │      │           缓存创意数据     创意判断在这里
                         └────────────┘      └───────────  ─────────────  ──────────
```

### 各模块职责一览

| 模块 | 输入 | 输出 | 知道什么 | 不知道什么 |
|---|---|---|---|---|
| Prompt Parser | prompt 文本 | tags[] | 关键词映射 | 广告脚本 |
| **Validator** | video + prompt | accept/reject/review | 视频技术缺陷 | Slot / 品牌 / 创意 |
| ShotPool | accept 的 Shot | Shot 列表 | (不判断) | (不判断) |
| Metadata 预算 | Shot (通过 Validator) | Shot + 缓存字段 | 产品可见度 / 构图 / 运动能量 | Slot 需求 |
| **Scheduler** | ShotPool + ScriptTemplate | RenderPlan | Slot 需求 / 品牌规范 / 创意标准 | (不关心视频技术质量) |
| Renderer | RenderPlan | 成片 MP4 | ffmpeg 参数 | (不关心选镜逻辑) |

---

## 6. 为什么这样划分更好

### 6.1 可维护性

**原设计的问题：Validator 既检测技术缺陷又做广告适配判断。**

如果 Hook 的定义变了（比如从"0.5s 动态"变成"1s 动态"），需要改 Validator 的 Layer 4 阈值。如果 Validator 的 Layer 3 模型升级了，可能影响 Layer 4 的 Hook 判断。两个职责耦合在一起。

**新设计：Validator 只管技术缺陷，阈值调优只影响"废片/不废片"。Scheduler 只管创意匹配，Slot 定义调整只影响"选谁不选谁"。互不干扰。**

### 6.2 可测试性

原设计要测 Layer 4 的 Hook Potential，需要构造一个"前 0.5s 有足够动态"的视频——这很难 mock。

新设计测 Scheduler 的 Hook Slot 匹配，只需要构造一个 `motionEnergy: "high"` 的 Shot 对象——纯数据，不需要视频文件。

### 6.3 可演进性

当业务需要新增 Slot 类型（比如"结尾 Logo 定帧"），只需要在 Scheduler 加一个 Slot 定义，不需要动 Validator。

当 AI 平台升级（比如 Runway Gen-4 减少了手指异常），只需要调 Validator Layer 3 的阈值，不需要动 Scheduler。

### 6.4 职责单一性验证

对 Validator 问三个问题：

| 问题 | 回答 |
|---|---|
| Validator 知道这段视频将用作 Hook 还是 Detail 吗? | 不知道 |
| Validator 知道品牌色是什么吗? | 不知道 |
| Validator 会因为"产品不够居中"而拒绝一个视频吗? | 不会 |

对 Scheduler 问三个问题：

| 问题 | 回答 |
|---|---|
| Scheduler 会检测视频有没有手指异常吗? | 不会（那是 Validator 的事） |
| Scheduler 需要跑 ffmpeg 吗? | 不需要 |
| Scheduler 会把视频从 ShotPool 删除吗? | 不会（只选不选，不删） |

**两个模块互不越界。**

---

## 7. Validator 仍是核心竞争力

职责收窄后，Validator 的壁垒是否减弱？

**没有。反而更强了。**

| 维度 | 收窄前 | 收窄后 |
|---|---|---|
| 检测范围 | 技术缺陷 + 广告适配 | 仅技术缺陷 |
| 调参复杂度 | 技术 + 广告 + 品牌（耦合） | 仅技术（解耦） |
| 模型训练目标 | 混合（既要检测 artifact 又要评价 Hook 适配） | 纯一（只检测 artifact） |
| 标注成本 | 高（标注者需要同时判断技术和创意） | 低（标注者只判断"有没有缺陷"） |
| 阈值调优 | 改 Hook 定义会影响 Validator | 完全隔离 |

**收窄后 Validator 的模型训练目标更纯粹——只做 artifact detection，不做 ad fitness scoring。准确率更容易提升，标注更容易规模化。**

广告适配性（Hook Potential / Product Visibility / Composition）是规则和阈值，放在 Scheduler 里用代码实现，不需要 AI 模型。Validator 的 AI 只做一件事：检测视频里有没有技术缺陷。

---

## 8. 淘汰率重新估算

删除 Layer 4 后，通过率会提高（因为不再因为"产品不够居中"或"Hook 不够动态"而拒绝）。

| Layer | 检测方式 | 预计淘汰率 | 累计通过率 |
|---|---|---|---|
| Layer 1: Technical | ffmpeg | ~8% | ~92% |
| Layer 2: Temporal | code | ~25% | ~69% |
| Layer 3: Artifact | AI model | ~25% | ~52% |
| Gray Zone | 人工 | ~50% of gray | ~48% |

**原方案通过率 ~40%（Layer 4 额外淘汰 ~8%）。新方案通过率 ~48%。**

多通过的 ~8% 是"技术上没问题但不适合做 Hook"的视频——它们进 ShotPool，被 Scheduler 分配到 Body 或 Detail。**不是废片，不该被 Validator 拒绝。**

---

## 9. 最终模块清单

### Validator（精简后）

```
ai-video-validator.mjs
│
├── validate(videoPath, prompt) → ValidationResult
│
├── Layer 1: TechnicalPass (ffmpeg)
│   ├── checkResolution()
│   ├── checkDuration()
│   ├── checkBitrate()
│   ├── checkFramerate()
│   └── checkGlobalFlicker()
│
├── Layer 2: TemporalPass (code)
│   ├── checkTextureBoil()
│   ├── checkOpticalFlow()        → warp / non_physical
│   ├── checkStutter()
│   └── checkCameraJump()
│
├── Layer 3: ArtifactPass (AI model)
│   ├── checkHumanAnomaly()       → 手/脸/肢体/比例/姿态/服装/眼
│   ├── checkProductDefect()      → 消失/形变/色漂/Logo/比例/纹理/融合
│   └── checkSceneDefect()        → 背景闪烁/物体凭空/光照/文字乱码
│
└── Gray Zone → Human Review Queue

ValidationResult:
  verdict: "accept" | "reject" | "review"
  rejectReason?: RejectReason
  artifacts: { type, confidence }[]
  tags: string[]                    // prompt 解析的 tags
```

**对比原设计：删除了 Layer 4 (AdSuitabilityPass) 整个层。**

### Metadata 预算（新增小模块）

```
metadata-budget.mjs
│
├── compute(shot) → Shot (with cache fields)
│   ├── computeProductVisibility()   // 帧间产品检测 → 百分比
│   ├── computeProductCentered()     // 产品 bbox 中心位置
│   └── computeMotionEnergy()        // 光流幅度 → high/medium/low
```

入池后执行，~1s/视频，结果缓存到 Shot 上。

### Scheduler（增强 Slot 定义）

```
shot-scheduler.mjs
│
├── schedule(shotPool, scriptTemplate) → RenderPlan
│   ├── matchByTags()           // V2 原有
│   ├── filterByDuration()      // V2 原有
│   ├── filterByProductVisibility()  // 新增（从 Validator L4 移入）
│   ├── filterByComposition()        // 新增
│   ├── filterByMotionEnergy()       // 新增
│   ├── rankByPreferTags()      // V2 原有
│   └── applyDiversityRule()    // V2 原有
```

### 模块变更汇总

| 模块 | 变更 |
|---|---|
| `ai-video-validator.mjs` | 删除 Layer 4，删除 Brand Artifact 分类 |
| `metadata-budget.mjs` | 新增，入池后计算创意缓存字段 |
| `shot-scheduler.mjs` | Slot 定义增强，增加创意筛选条件 |
| AI Artifact Taxonomy | 6 类 → 5 类，删除 Brand Artifact |
| RejectReason | 删除 4 个 brand: 编码，text_artifact 改为 scene: 前缀 |
| Shot schema | 新增 3 个可选缓存字段 |

---

## 10. 一句话总结

**Validator 只回答一个问题：这个视频有没有技术缺陷。**

有缺陷 → 废片桶。没缺陷 → ShotPool。至于它适合做 Hook 还是 Detail，是 Scheduler 的事。

Validator 不评价创意。不评价 CTR。不评价 Prompt。不给生成建议。不知道品牌色。不知道 Hook 是什么。

**它只是一个质量门禁。仅此而已。**
