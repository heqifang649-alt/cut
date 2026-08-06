# Dual Pipeline Architecture — AI Footage Pipeline 设计

> 日期：2026-08-05
> 角色：Staff Engineer, Ad Tech
> 前提：V2（Real Footage Pipeline）保留不动，作为 Real Footage Pipeline 继续运行
> 目标：设计第二条 Pipeline — AI Footage Pipeline，与 Real Pipeline 在 ShotPool 层汇合
> 规模假设：500 批次/天，10000 视频/天，10 Worker，3 GPU，多名设计师
> 未来假设：90% 素材来自 AI 生成

---

## 0. Executive Summary

### 核心判断

**如果 90% 广告素材来自 AI 视频，系统最大的竞争力不是自动剪辑，而是 AI Video Validator。**

理由：

1. **生成能力正在商品化。** Runway、Veo、Kling、Pika、Hailuo——所有人都能用同样的工具生成视频。生成本身不构成壁垒。
2. **AI 视频废片率极高。** 实测约 30-50% 的 AI 生成视频存在肉眼可见的 artifact（手指异常、产品消失、纹理沸腾等）。10000 视频/天的规模下，人工逐条审核需要 50+ 人。
3. **剪辑逻辑已经解决。** V2 的 Tag+Slot 调度器 < 100ms 完成选镜，渲染 30-120s。瓶颈不在剪辑，在素材质量过滤。
4. **Validator 是数据飞轮。** 每一条人工 accept/reject 的记录都是训练信号。Validator 越用越准，竞争者从零起步追赶需要积累同样的标注数据。

### 架构判决

| 模块 | 判决 |
|---|---|
| Real Footage Pipeline (V2) | **保留，不动一行** |
| AI Footage Pipeline | **新建** |
| AI Video Validator | **新建，系统最高优先级模块** |
| ShotPool | **共享，schema 只加 1 个字段** |
| Scheduler (Tag+Slot) | **完全复用** |
| Renderer | **完全复用** |
| Review UI | **完全复用** |

---

## 1. AI Artifact Taxonomy — AI 废片分类体系

### 为什么需要独立分类体系

实拍视频的 reject 原因是 `blur` / `unstable` / `exposure`——这些是物理世界的问题。

AI 视频的 reject 原因完全不同。AI 不存在"手抖了"或"曝光不对"——AI 的问题是人手长了 7 根手指、产品在第 2 秒消失、墙壁纹理像水一样沸腾。

用实拍的 3 个 reject reason 覆盖 AI 视频，等于用感冒药治癌症。

### 完整分类体系

```
AI Artifact Taxonomy
├── 1. Human Artifact（人物异常）
│   ├── hand_anomaly          手指异常：多指/少指/融合指/手指变形
│   ├── face_drift            面部跳变：人脸在不同帧间变成另一个人
│   ├── limb_mutation         四肢异常：多肢/少肢/融合肢/肢体穿模
│   ├── body_proportion       身体比例异常：躯干过长/头身比失调/突然变大变小
│   ├── pose_impossible       姿态异常：关节反弯/悬浮肢体/不可能姿势
│   ├── walk_breakdown        步态崩坏：走路时腿部运动违反物理
│   ├── clothing_fusion       服装穿模：衣服与皮肤融合/衣服穿透身体
│   └── eye_anomaly           眼部异常：不对称/多瞳/死鱼眼/独立移动
│
├── 2. Product Artifact（产品异常）※ 广告特有，最高优先级
│   ├── product_dissolution   产品消失：产品在视频中段消失
│   ├── product_deformation   产品形变：产品形状随时间变化（融化/扭曲）
│   ├── color_drift           颜色漂移：产品颜色在帧间偏移
│   ├── logo_inconsistent     Logo 不一致：Logo 变形/移位/消失/变色
│   ├── pattern_inconsistent  印花不一致：图案/纹理在中途变化
│   ├── scale_shift           比例异常：产品无故放大/缩小
│   ├── texture_drift         纹理漂移：产品表面纹理不断变化
│   └── product_bg_fusion     产品背景融合：产品边缘融化进背景
│
├── 3. Scene Artifact（画面异常）
│   ├── bg_flicker            背景闪烁：背景元素闪烁/频闪
│   ├── texture_boil          纹理沸腾：表面纹理不断变化（最常见的 AI artifact）
│   ├── object_spawn          物体凭空出现/消失：随机物体在中途出现或消失
│   ├── lighting_shift        光照不一致：光源方向/强度/色温在中途变化
│   ├── shadow_anomaly        阴影异常：阴影与物体不匹配/独立移动
│   └── reflection_error      反射错误：镜面反射内容与现实不符
│
├── 4. Motion Artifact（运动异常）
│   ├── non_physical_motion   非物理运动：物体瞬移/悬浮/不自然滑动
│   ├── camera_jump           Camera Jump：镜头位置突然跳变（视差断裂）
│   ├── parallax_error        视差错误：深度关系断裂
│   └── warp_artifact         空间扭曲：空间本身弯曲变形
│
├── 5. Temporal Artifact（时序异常）※ AI 视频最独特的类别
│   ├── frame_stutter         掉帧卡顿：画面瞬间冻结后跳跃
│   ├── global_flicker        全局闪烁：整体亮度在帧间振荡
│   ├── style_shift           风格跳变：视频在中途突然变成另一种风格
│   └── temporal_boiling      时序沸腾：皮肤/布料/墙壁纹理在所有帧上持续抖动
│
└── 6. Brand Artifact（品牌异常）※ 广告专用
    ├── product_visibility    产品可见度不足：产品可见时间 < 80%
    ├── product_occluded       产品被遮挡：产品被其他元素遮挡过多
    ├── composition_poor       构图不佳：产品过小/偏框/构图不利于广告
    ├── text_artifact          文字异常：画面中文字乱码/拼写错误
    └── brand_color_mismatch   品牌色不匹配：颜色与品牌规范不符
```

### 分类设计原则

1. **每个类别对应一个检测方法。** Human Artifact 用人体检测模型，Product Artifact 用帧间对比，Temporal Artifact 用帧差统计。不混合检测方法。
2. **分类粒度到「可指导重新生成」。** 设计师看到 `hand_anomaly` → 知道要在 prompt 里加 "detailed hands, correct finger count"。看到 `product_dissolution` → 知道要加 "product remains visible throughout"。
3. **Brand Artifact 与技术 Artifact 分离。** 一个视频可能技术上完美（无 artifact）但品牌上不合格（产品太小）。这两种 reject 的处理方式不同：技术 artifact → 重新生成；品牌不合格 → 调整 prompt 参数重新生成。

### rejectReason 编码规范

```typescript
type RejectReason =
  // Technical (Layer 1-2, code-detected)
  | "tech:low_resolution"
  | "tech:duration_invalid"
  | "tech:low_bitrate"
  | "tech:framerate_inconsistent"
  | "tech:global_flicker"
  | "tech:texture_boil"
  | "tech:stutter"
  // Human (Layer 3, AI-detected)
  | "human:hand_anomaly"
  | "human:face_drift"
  | "human:limb_mutation"
  | "human:body_proportion"
  | "human:pose_impossible"
  | "human:clothing_fusion"
  | "human:eye_anomaly"
  // Product (Layer 3, AI-detected)
  | "product:dissolution"
  | "product:deformation"
  | "product:color_drift"
  | "product:logo_inconsistent"
  | "product:scale_shift"
  | "product:texture_drift"
  | "product:bg_fusion"
  // Scene (Layer 3, AI-detected)
  | "scene:bg_flicker"
  | "scene:object_spawn"
  | "scene:lighting_shift"
  | "scene:shadow_anomaly"
  // Motion (Layer 2-3)
  | "motion:non_physical"
  | "motion:camera_jump"
  | "motion:warp"
  // Brand (Layer 4, code/rule)
  | "brand:product_visibility"
  | "brand:composition"
  | "brand:text_artifact"
  | "brand:color_mismatch"
  // Gray zone
  | "review:low_confidence";
```

---

## 2. AI Video Validator — 架构设计

### 核心原则：Cascade（级联），不是 Monolith（单体）

AI 视频 artifact 有一个关键特性：**便宜的检测能淘汰大部分废片。**

- 全局闪烁（global_flicker）用帧间亮度方差就能检测，< 1s，零 GPU。
- 纹理沸腾（texture_boil）用逐像素时序方差就能检测，< 5s，零 GPU。
- 这两个 artifact 覆盖了约 30-40% 的 AI 废片。

所以 Validator 不应该对每个视频都跑完整 AI 分析。应该先跑便宜的代码检测，淘汰明显废片，再对存活的视频跑 AI 检测。

### 四层 Cascade 架构

```
Input: AI video file + generation prompt + product reference image (optional)
                    │
                    ▼
    ┌─────────────────────────────────────────────┐
    │  Layer 1: Technical Pass (ffmpeg, < 1s)       │
    │                                               │
    │  - 分辨率 ≥ 720p?                              │
    │  - 时长 ∈ [2s, 15s]?                          │
    │  - 码率 ≥ 阈值?                               │
    │  - 帧率一致 (无掉帧)?                          │
    │  - 全局闪烁: 帧间平均亮度方差 > 阈值?          │
    │                                               │
    │  检测: tech:low_resolution / tech:duration_   │
    │       invalid / tech:low_bitrate / tech:     │
    │       framerate_inconsistent / tech:global_   │
    │       flicker                                 │
    └─────────────────────────────────────────────┘
         │ Pass                    │ Fail
         ▼                         ▼
    ┌────────────────┐         REJECT
    │                                     │
    ▼                                     │
    ┌─────────────────────────────────────────────┐
    │  Layer 2: Temporal Stability (code, < 5s)    │
    │                                               │
    │  - 逐像素时序方差 (纹理沸腾检测):              │
    │    对每个像素计算跨帧方差，若 > 40% 的像素     │
    │    方差超阈值 → texture_boil                   │
    │                                               │
    │  - 光流一致性 (空间扭曲检测):                  │
    │    计算前后帧光流，若光流向量出现不连续 →      │
    │    warp_artifact                              │
    │                                               │
    │  - 运动向量合理性 (非物理运动检测):            │
    │    物体位移过大/方向突变 → non_physical_motion │
    │                                               │
    │  - 卡顿检测: 帧间 SSIM 突然下降后恢复 →        │
    │    frame_stutter                              │
    │                                               │
    │  检测: tech:texture_boil / tech:stutter /     │
    │       motion:warp / motion:non_physical /     │
    │       motion:camera_jump                      │
    └─────────────────────────────────────────────┘
         │ Pass                    │ Fail
         ▼                         ▼
    ┌────────────────┐         REJECT
    │                                     │
    ▼                                     │
    ┌─────────────────────────────────────────────────┐
    │  Layer 3: Artifact Detection (AI model, 10-30s)  │
    │                                                   │
    │  这是 Validator 的核心。                          │
    │  只有通过了 Layer 1-2 的视频才进入此层。            │
    │                                                   │
    │  3a. Product Consistency Check:                   │
    │      - 提取首帧、中帧、末帧                        │
    │      - 对比三帧中的产品区域                        │
    │      - 产品消失 → product:dissolution              │
    │      - 形状变化 → product:deformation             │
    │      - 颜色偏移 → product:color_drift              │
    │      - 比例变化 → product:scale_shift              │
    │      (如有产品参考图，额外做 logo/pattern 比对)    │
    │                                                   │
    │  3b. Human Anomaly Check:                         │
    │      - 人体检测 (如有人物)                        │
    │      - 手部区域分析 → human:hand_anomaly           │
    │      - 面部一致性 → human:face_drift               │
    │      - 肢体数量/位置 → human:limb_mutation         │
    │      - 比例分析 → human:body_proportion            │
    │                                                   │
    │  3c. Scene Stability Check:                      │
    │      - 背景区域分析 → scene:bg_flicker             │
    │      - 物体连续性 → scene:object_spawn             │
    │      - 光源一致性 → scene:lighting_shift           │
    │                                                   │
    │  输出: artifact 列表 + 每个的置信度 (0-1)          │
    │  判定: 任一 artifact 置信度 > 0.85 → REJECT       │
    │        所有 artifact 置信度 < 0.5 → PASS           │
    │        存在 0.5-0.85 的 → 灰区 (Layer 5)           │
    └─────────────────────────────────────────────────┘
         │ Pass      │ Fail       │ Gray (0.5-0.85)
         ▼           ▼            ▼
    ┌──────────┐  REJECT     ┌──────────────┐
    │                        │  Layer 5:     │
    │                        │  Human Review │
    │                        │  Queue         │
    │                        └──────────────┘
    ▼
    ┌─────────────────────────────────────────────┐
    │  Layer 4: Ad Suitability (code + rules, < 1s) │
    │                                               │
    │  - 产品可见度: 逐帧检测产品是否在画面内         │
    │    (用 Layer 3 的产品区域结果)                 │
    │    可见时间 < 80% → brand:product_visibility   │
    │                                               │
    │  - 产品位置: 产品 bbox 中心是否在画面安全区?    │
    │    不在 → brand:composition                    │
    │                                               │
    │  - Hook 潜力: 前 0.5s 是否有足够动态?           │
    │    (光流幅度 > 阈值)                            │
    │    不足 → 不 reject, 但不加 hook tag            │
    │                                               │
    │  - 文字检测: 画面中是否有乱码文字?              │
    │    有 → brand:text_artifact                    │
    └─────────────────────────────────────────────┘
         │ Pass
         ▼
    ACCEPT → ShotPool
```

### 各层预计淘汰率

基于 AI 视频生成（Runway/Veo/Kling）的典型废片率估算：

| Layer | 检测方式 | 耗时/视频 | GPU 占用 | 预计淘汰率 | 累计通过率 |
|---|---|---|---|---|---|
| Layer 1: Technical | ffmpeg | < 1s | 0 | ~5-10% | ~92% |
| Layer 2: Temporal | code (光流/方差) | < 5s | 0 | ~20-30% | ~65% |
| Layer 3: Artifact | AI model | 10-30s | 1 GPU 路 | ~20-30% | ~48% |
| Layer 4: Ad Suitability | code + rules | < 1s | 0 | ~5-10% | ~43% |
| Layer 5: Human Review | 人工 | ~10s/视频 | 0 | ~50% of gray zone | ~40% |

**结果：10000 视频/天输入 → ~4000 通过 → 进入 ShotPool。**

### GPU 时间估算

| Layer | 视频数 | 单视频耗时 | GPU 路数 | 总 GPU 时间 |
|---|---|---|---|---|
| Layer 1 | 10000 | < 1s | 0 (CPU) | 0 |
| Layer 2 | ~9200 | < 5s | 0 (CPU) | 0 |
| Layer 3 | ~6500 | 15s (中位) | 12 (3 GPU × 4 路) | ~2.3 小时 |
| Layer 4 | ~4500 | < 1s | 0 (CPU) | 0 |
| **总计** | | | | **~2.3 小时 GPU/天** |

3 台 GPU 每天只跑 2.3 小时。剩余 21.7 小时可用于离线模型训练/优化。

**对比 V1 原方案**：10000 视频 × 45s Codex = 125 小时 GPU/天 → 需要 5 台 GPU 满负荷 24 小时运行。新方案 GPU 用量减少 **98%**。

### Layer 3 的模型选择

Layer 3 是唯一需要 AI 的层。关键设计决策：**不用通用多模态大模型（Codex/GPT-4V），用专用检测模型。**

理由：
1. 通用模型对 AI artifact 的检测准确率不稳定（~70-80%），因为它们不是为此训练的。
2. 专用模型可以针对 AI artifact 微调，准确率可达 90%+。
3. 专用模型推理速度快 5-10 倍（15s vs 60-120s）。
4. 专用模型不需要 token 配额（不受 Codex 用量限制影响）。

**模型选型（按优先级）：**

| 方案 | 模型 | 优势 | 劣势 |
|---|---|---|---|
| A (推荐) | 开源视频质量模型 (如 DOVER/VRTM) + 自训练分类头 | 完全可控，无 API 依赖，可针对业务微调 | 需要标注数据 |
| B | 商用 API (如 VisionOne/腾讯智影) | 快速接入 | 成本高，数据不出域 |
| C | Codex/GPT-4V (最后选择) | 已有接入 | 慢、贵、受配额限制、准确率不够 |

**初期策略：** 用 Codex 做 Layer 3 的 bootstrapping——标注 5000 条 AI 视频的 artifact（人工确认），同时用 Codex 检测。标注完成后训练专用模型，替换 Codex。Codex 在这个系统里的角色从"生产路径上的 AI"变成"训练数据生成器"。

---

## 3. Prompt → Metadata → ShotPool 自动映射

### 核心洞察

AI 视频天然携带结构化信息。生成时就有 Prompt、Camera、Motion、Style。这些信息直接映射为 Shot 的 tags，不需要任何检测。

### 三层映射

```
Tier 1: 直接来自 Prompt（100% 可靠，0 成本，0 AI）
    │   Prompt 关键词 → Tag
    ▼
Tier 2: 需要 AI 验证（Validator Layer 3 顺便完成）
    │   Prompt 声称 → 实际验证
    ▼
Tier 3: 完全不需要（删除）
    原来实拍需要的步骤，AI 视频不需要
```

### Tier 1: Prompt 直接映射（0 成本）

| Prompt 中的关键词 | → Shot Tag | 说明 |
|---|---|---|
| "close-up" / "close up" / "macro" / "特写" | `close_up` | 构图 tag |
| "wide shot" / "full shot" / "全景" | `wide` | 构图 tag |
| "full body" / "full-body" / "全身" | `full_body` | 构图 tag |
| "upper body" / "medium shot" / "半身" | `upper_body` | 构图 tag |
| "front view" / "frontal" / "正面" | `front` | 朝向 tag |
| "side view" / "profile" / "侧面" | `side` | 朝向 tag |
| "back view" / "rear" / "背面" | `back` | 朝向 tag |
| "zoom in" / "push in" / "推进" | `zoom_in` | 运镜 tag |
| "zoom out" / "pull out" / "拉远" | `zoom_out` | 运镜 tag |
| "pan" / "panning" / "平移" | `pan` | 运镜 tag |
| "tilt" / "俯仰" | `tilt` | 运镜 tag |
| "tracking" / "follow" / "跟随" | `tracking` | 运镜 tag |
| "static" / "still" / "locked off" / "固定" | `static` | 运镜 tag |
| "slow motion" / "slowmo" / "慢动作" | `slow_mo` | 风格 tag |
| "product detail" / "detail shot" / "细节" | `detail` | 用途 tag |
| "dynamic" / "energetic" / "动感" | `hook` | 用途 tag |
| "lifestyle" / "生活场景" | `lifestyle` | 风格 tag |
| "studio" / "影棚" | `studio` | 场景 tag |
| "outdoor" / "户外" | `outdoor` | 场景 tag |

**映射逻辑**：解析 Prompt 文本，正则匹配关键词，直接生成 tags 数组。10 行代码，< 1ms。

### Tier 2: 需要 AI 验证（Validator 顺便做）

| 需要验证的 | 验证方式 | 成本 |
|---|---|---|
| 产品是否真的在画面中 | Validator Layer 3 的 Product Consistency Check | 0 额外成本（已包含） |
| Hook 是否真的有冲击力 | Validator Layer 4 的 Hook 潜力检测 | 0 额外成本 |
| 品牌色是否匹配 | Validator Layer 4 的品牌色检测 | 0 额外成本 |

**关键：Tier 2 的验证全部在 Validator 的现有流程中完成，不增加任何额外调用。**

### Tier 3: 完全不需要（与实拍的本质区别）

| 实拍需要的步骤 | AI 视频为什么不需要 |
|---|---|
| Scene Detection（镜头切分） | AI 视频是单镜头，一个视频 = 一个 Shot。不需要切分。 |
| 产品识别 | Prompt 里写了产品名。 |
| 产品图识别 | 同上。 |
| 朝向识别 | Prompt 里写了 "front view"。 |
| 构图识别 | Prompt 里写了 "close-up"。 |
| 运镜识别 | Prompt 里写了 "zoom in"。 |
| 语义分析 | Prompt 已经描述了一切。 |
| 调色 | AI 自带风格化色彩。 |
| OverallScore | 与 V2 相同：Tag+Slot 匹配，不需要分数。 |

### Prompt 解析器设计

```typescript
// prompt-parser.mjs — 10 行核心逻辑
const TAG_MAPPING = {
  // composition
  "close.?up|macro|特写": "close_up",
  "wide.?shot|full.?shot|全景": "wide",
  "full.?body|全身": "full_body",
  "upper.?body|medium.?shot|半身": "upper_body",
  // orientation
  "front|frontal|正面": "front",
  "side|profile|侧面": "side",
  "back|rear|背面": "back",
  // camera motion
  "zoom.?in|push.?in|推进": "zoom_in",
  "zoom.?out|pull.?out|拉远": "zoom_out",
  "pan|平移": "pan",
  "tilt|俯仰": "tilt",
  "track|follow|跟随": "tracking",
  "static|still|locked|固定": "static",
  // usage
  "detail.?shot|细节": "detail",
  "dynamic|energetic|动感|hook": "hook",
  // style
  "slow.?mo|慢动作": "slow_mo",
  "lifestyle|生活": "lifestyle",
  "studio|影棚": "studio",
  "outdoor|户外": "outdoor",
};

function parsePromptToTags(prompt: string): string[] {
  const tags: string[] = [];
  const lower = prompt.toLowerCase();
  for (const [pattern, tag] of Object.entries(TAG_MAPPING)) {
    if (new RegExp(pattern, "i").test(lower)) {
      tags.push(tag);
    }
  }
  return tags;
}
```

### 完整映射流程

```
AI 生成平台输出:
  video.mp4
  prompt: "Close-up shot of a red lipstick on marble counter,
           slow zoom in, studio lighting, product detail"
  metadata: { duration: 5s, resolution: 1080p, model: "runway-gen3" }

        │
        ▼

  Prompt Parser (code, < 1ms)
    → tags: ["close_up", "zoom_in", "studio", "detail"]
    → productId: "red_lipstick" (从 prompt 提取或从文件夹名)

        │
        ▼

  AI Video Validator (4-layer cascade)
    → Layer 1-2: 技术检测 (code, < 6s)
    → Layer 3: Artifact 检测 (AI, 10-30s)
    → Layer 4: 广告适配 (code, < 1s)
    → reject: false / true + rejectReason

        │
        ▼

  ShotPool 入池:
    {
      id: uuid(),
      source: "batch_001/red_lipstick/runway_001",
      path: "/storage/ai/batch_001/red_lipstick/runway_001.mp4",
      start: 0,           // AI 视频始终从 0 开始
      end: 5.0,           // = duration
      duration: 5.0,
      tags: ["close_up", "zoom_in", "studio", "detail"],
      reject: false,
      rejectReason: null,
      origin: "ai"        // ← 唯一新增字段
    }
```

---

## 4. Dual Pipeline 架构

### 总体架构图

```
═══════════════════════════════════════════════════════════════
  REAL FOOTAGE PIPELINE (V2, 不动)
═══════════════════════════════════════════════════════════════

  [人工拍摄]
    ├── 按产品分文件夹
    ├── 一镜一动作（遮镜头分隔）
    ├── 拍摄标签卡
    └── 统一白平衡 + LUT
          │
          ▼
  [INGEST — 代码]
    ├── 文件夹扫描 → source / tags
    ├── ffmpeg scene detection → 切分
    └── ffmpeg 技术检测 → reject
          │
          │  Shot { origin: "real" }
          │
          ▼
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─
                    ShotPool (共享)
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─
          ▲
          │
          │  Shot { origin: "ai" }
          │
═══════════════════════════════════════════════════════════════
  AI FOOTAGE PIPELINE (新建)
═══════════════════════════════════════════════════════════════

  [AI 生成]
    Runway / Veo / Kling / Pika / Hailuo
    输出: video.mp4 + prompt + metadata
          │
          ▼
  [PROMPT PARSE — 代码, < 1ms]
    prompt → tags[]
    prompt → productId
          │
          ▼
  [AI VIDEO VALIDATOR — 4-layer cascade]
    Layer 1: Technical (ffmpeg, < 1s)     ── 淘汰 ~8%
    Layer 2: Temporal (code, < 5s)        ── 淘汰 ~25%
    Layer 3: Artifact (AI model, 10-30s)  ── 淘汰 ~25%
    Layer 4: Ad Suitability (code, < 1s)  ── 淘汰 ~8%
    Layer 5: Gray Zone → Human Review     ── 淘汰 ~50% of gray
          │
          │  reject: false → 入池
          │  reject: true  → 废片桶（附 rejectReason）
          │
          ▼
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─
                    ShotPool (共享)
─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─
          │
          ▼
  [SCHEDULER — 代码, < 100ms]     ← 完全复用 V2
    Tag + Slot 匹配 → RenderPlan
          │
          ▼
  [RENDERER — ffmpeg]              ← 完全复用 V2
    concat + 音乐卡点 + 字幕
          │
          ▼
  [REVIEW — 人工]                  ← 完全复用 V2
    设计师看成片 → 满意/要求改
```

### 共享层改动量：极小

ShotPool schema 只加 1 个字段：

```typescript
type Shot = {
  id: string;
  source: string;
  path: string;
  start: number;       // Real: ffmpeg 切分结果; AI: 0
  end: number;         // Real: ffmpeg 切分结果; AI: duration
  duration: number;
  tags: string[];      // Real: 人工标注; AI: prompt 解析
  reject: boolean;
  rejectReason?: string;
  origin: "real" | "ai";  // ← 唯一新增字段
};
```

**Scheduler 不需要知道 Shot 来自哪条 Pipeline。** 它只看 tags + duration + reject。Real 和 AI 的 Shot 在调度器眼里完全等价。

**Renderer 不需要知道 Shot 来自哪条 Pipeline。** 它只读 path + start + end，用 ffmpeg 提取片段拼接。

**Review UI 不需要大改。** 最多在镜头卡片上加一个小标签显示 "AI" / "Real"，方便设计师知道素材来源。

### 两条 Pipeline 可以混合使用

同一个批次可以同时包含实拍和 AI 视频：

```
batch_001/
  real_footage/
    lipstick_red/
      front.mov          → Real Pipeline → ShotPool
      side.mov
  ai_footage/
    lipstick_red/
      runway_001.mp4     → AI Pipeline → ShotPool
      veo_002.mp4
      kling_003.mp4
```

Scheduler 从同一个 ShotPool 中选镜，不区分来源。一个成片可以同时包含实拍 Hook + AI Body + 实拍 Detail——完全由 Tag+Slot 匹配决定。

---

## 5. AI Video Validator — 作为系统核心模块的详细设计

### 为什么 Validator 是系统最重要的模块

**场景假设：90% 素材来自 AI 视频。**

在这个场景下：

| 能力 | 是否构成壁垒 | 理由 |
|---|---|---|
| AI 视频生成 | ❌ | 所有人都能用 Runway/Veo/Kling |
| 自动剪辑 (Tag+Slot) | ⚠️ 弱壁垒 | 逻辑简单，竞争者 1 周可以复制 |
| 渲染 (ffmpeg) | ❌ | 开源工具，无壁垒 |
| **AI Video Validator** | **✅ 强壁垒** | 需要大量标注数据 + 专用模型 + 持续迭代 |

**Validator 的护城河来自三个维度：**

1. **数据飞轮。** 每天处理 10000 视频，人工 review 灰区的每一条都是标注数据。3 个月后 = 90 万条标注。竞争者从零开始需要同样时间。

2. **专用模型。** 通用 AI 模型（GPT-4V/Codex）对 AI artifact 的检测准确率 ~70%。专用模型经过业务数据微调后可达 90%+。这个差距在 10000 视频/天规模下意味着每天多淘汰 2000 条废片 vs 放过 2000 条废片进 ShotPool——后者直接导致成片质量下降。

3. **Cascade 调优。** 每层的阈值（亮度方差、纹理方差、光流一致性）需要针对不同 AI 平台的输出特性调参。Runway 的纹理沸腾模式和 Kling 的不同，Veo 的手指异常分布和 Pika 的不同。这些经验值需要长期积累。

### Validator 模块内部架构

```
ai-video-validator.mjs
│
├── validate(videoPath, prompt, productRef?) → ValidationResult
│
├── Layer 1: TechnicalPass (ffmpeg)
│   ├── checkResolution()
│   ├── checkDuration()
│   ├── checkBitrate()
│   ├── checkFramerate()
│   └── checkGlobalFlicker()     // 帧间亮度方差
│
├── Layer 2: TemporalPass (code, 光流/方差)
│   ├── checkTextureBoil()       // 逐像素时序方差
│   ├── checkOpticalFlow()       // 光流一致性 → warp/non_physical
│   ├── checkMotionVector()      // 运动向量合理性
│   └── checkStutter()           // SSIM 突变检测
│
├── Layer 3: ArtifactPass (AI model)
│   ├── checkProductConsistency()  // 首中末帧产品区域对比
│   ├── checkHumanAnomaly()        // 手/脸/肢体检测
│   └── checkSceneStability()      // 背景/物体连续性
│
├── Layer 4: AdSuitabilityPass (code + rules)
│   ├── checkProductVisibility()   // 产品可见时间百分比
│   ├── checkComposition()        // 产品在画面中的位置
│   ├── checkHookPotential()      // 前 0.5s 动态
│   └── checkTextArtifact()       // 文字乱码检测
│
└── Layer 5: HumanReviewQueue
    └── addToReviewQueue()         // 灰区视频入队

ValidationResult:
  verdict: "accept" | "reject" | "review"
  rejectReason?: RejectReason
  artifacts: { type, confidence }[]  // Layer 3 输出的所有 artifact
  tags: string[]                       // prompt 解析的 tags
  metrics: {
    layer1Time: number,
    layer2Time: number,
    layer3Time: number,
    layer4Time: number,
  }
```

### 废片桶设计

被 reject 的视频不丢弃，进入"废片桶"：

```typescript
type RejectBin = {
  videoPath: string;
  prompt: string;
  rejectReason: RejectReason;
  rejectLayer: 1 | 2 | 3 | 4;
  timestamp: string;
  aiPlatform: "runway" | "veo" | "kling" | "pika" | "hailuo" | "unknown";
  // 用于统计哪个平台的哪种 artifact 最常见
};
```

**废片桶的价值：**
- 统计各 AI 平台的废片率和 artifact 分布 → 指导"哪个平台生成什么类型的镜头质量最高"
- 积累标注数据 → 训练专用检测模型
- 分析 prompt 与 artifact 的关联 → "这个 prompt 模式容易产生手部异常"

### 灰区人工 Review 流程

```
Layer 3 输出: artifact 置信度在 0.5-0.85 之间
    │
    ▼
入队 Human Review Queue
    │
    ▼
设计师在 Review UI 看到:
  ┌──────────────────────────────────────┐
  │ ⚠️ 待人工审核 (3 条)                   │
  │                                       │
  │ [视频缩略图]  runway_001.mp4          │
  │ Prompt: "Close-up of red lipstick..." │
  │ AI 检测: hand_anomaly (置信度 0.62)    │
  │                                       │
  │  [✅ 通过]  [❌ 拒绝]  [🔍 查看详情]   │
  └──────────────────────────────────────┘

设计师点击通过/拒绝 → 记录成为标注数据
```

**灰区处理的效率：**
- 预计灰区占总量 ~5-10% = 500-1000 视频/天
- 每条审核 ~10s（看视频 + 判断）
- 500 条 × 10s = 83 分钟 → 1-2 个设计师兼职即可

---

## 6. 模块清单

### 保留（完全复用 V2）

| 模块 | 来源 | 说明 |
|---|---|---|
| `batch-renderer.mjs` | V2 | ffmpeg 渲染，不区分 Real/AI |
| `lib/store.ts` | V2 | 批次存储 |
| `lib/atomic-json.mjs` | V2 | 原子写入 |
| `shot-scheduler.mjs` | V2 | Tag+Slot 匹配，不区分 Real/AI |
| `delivery-watcher.mjs` | V2 | 交付流程 |
| `chatcut-sync.mjs` | V2 | ChatCut 同步 |
| `app/page.tsx` | V2 (微调) | 加 origin 标签显示 |
| `app/globals.css` | V2 (微调) | 加 AI/Real 标签样式 |

### 新增

| 模块 | 职责 | 实现方式 |
|---|---|---|
| `ai-video-validator.mjs` | 4-layer cascade 质量检测 | Layer 1-2 纯 code；Layer 3 AI 模型；Layer 4 code+rules |
| `prompt-parser.mjs` | Prompt → tags 自动映射 | 正则匹配，10 行核心逻辑 |
| `ai-ingest.mjs` | AI 视频入池流程 | 调用 prompt-parser + validator → 写入 ShotPool |
| `review-queue.mjs` | 灰区人工审核队列 | 存储 + UI 展示 |

### 修改

| 模块 | 改动 |
|---|---|
| `Shot` 类型 | 加 `origin: "real" \| "ai"` 字段 |
| `processor.mjs` | 加 AI 视频处理分支：检测到 AI 视频文件夹 → 走 AI Pipeline |
| `app/page.tsx` | ShotPool 面板加 origin 标签；新增灰区审核入口 |

### 不需要新增（与 V1 原方案对比）

| V1 原方案的模块 | AI Pipeline 是否需要 | 理由 |
|---|---|---|
| `shot-detector.mjs` (scene detection) | ❌ | AI 视频是单镜头，不需要切分 |
| `shot-quality-tech.mjs` | ❌ | Validator Layer 1-2 已覆盖 |
| `shot-quality-semantic.mjs` | ❌ | Prompt 已包含所有语义信息 |
| OverallScore | ❌ | Tag+Slot 不需要分数 |
| DiversityConfig + sourcePenalty | ❌ | V2 的「最近 N 个 source 不重复」已够 |

---

## 7. AI Pipeline 完整流程

```
═══════════════════════════════════════════════════════════════
  GENERATE — AI 生成阶段（外部，系统不参与）
═══════════════════════════════════════════════════════════════

  设计师/运营在 AI 平台生成视频:
  - Runway / Veo / Kling / Pika / Hailuo
  - 输出: video.mp4 + prompt + platform metadata
  - 下载到: /storage/ai/batch_id/product_name/platform_001.mp4

  耗时: 不计入系统（外部生成）
  AI 调用: 0（系统不参与生成）

═══════════════════════════════════════════════════════════════
  PARSE — Prompt 解析（代码，< 1ms）
═══════════════════════════════════════════════════════════════

  1. 读取视频文件的 prompt（从文件名 sidecar .txt 或 metadata）
  2. 正则匹配 → tags[]
  3. 提取 productId（从文件夹名或 prompt）

  输出: { tags, productId, path, duration }

  耗时: < 1ms
  AI 调用: 0

═══════════════════════════════════════════════════════════════
  VALIDATE — AI Video Validator（4-layer cascade）
═══════════════════════════════════════════════════════════════

  Layer 1: Technical (ffmpeg, < 1s)
    → 淘汰: 低分辨率/错误时长/低码率/掉帧/全局闪烁

  Layer 2: Temporal (code, < 5s)
    → 淘汰: 纹理沸腾/卡顿/空间扭曲/非物理运动/camera jump

  Layer 3: Artifact (AI model, 10-30s)
    → 淘汰: 产品消失/形变/色漂 + 手指异常/面部跳变/肢体突变 + 背景闪烁/物体凭空出现
    → 灰区: 置信度 0.5-0.85 → 人工审核

  Layer 4: Ad Suitability (code, < 1s)
    → 淘汰: 产品可见度低/构图差/文字乱码

  耗时: 6-36s/视频（取决于在哪层被淘汰）
  AI 调用: 0-1（仅 Layer 3，且仅对通过 Layer 1-2 的视频）

═══════════════════════════════════════════════════════════════
  INGEST — 入池（代码，< 1s）
═══════════════════════════════════════════════════════════════

  Validator verdict == "accept":
    → 写入 ShotPool
    → Shot { origin: "ai", tags: [...], duration, reject: false }

  Validator verdict == "reject":
    → 写入废片桶
    → 附 rejectReason（可指导重新生成）

  Validator verdict == "review":
    → 入 Human Review Queue
    → 设计师审核后 → accept/reject

  耗时: < 1s
  AI 调用: 0

═══════════════════════════════════════════════════════════════
  SCHEDULE + RENDER + REVIEW — 完全复用 V2
═══════════════════════════════════════════════════════════════

  Scheduler: Tag+Slot 匹配 → RenderPlan (< 100ms)
  Renderer: ffmpeg concat + 音乐 + 字幕 (30-120s/产品)
  Review: 设计师看成片 → 满意/改 tag/改 slot → 重新调度

  零修改。Scheduler 不知道 Shot 是 Real 还是 AI。
```

---

## 8. 与 V2 的对比

| 维度 | Real Footage Pipeline (V2) | AI Footage Pipeline (新) |
|---|---|---|
| 素材来源 | 人工拍摄 | AI 生成平台 |
| 产品识别 | 文件夹名 | Prompt |
| 构图/朝向/运镜 | 人工标签卡 | Prompt 自动解析 |
| 镜头切分 | ffmpeg scene detection | 不需要（单镜头） |
| 调色 | 统一白平衡 + LUT | 不需要（AI 自带） |
| 质量门禁 | ffmpeg 技术检测 (blur/unstable/exposure) | 4-layer cascade Validator (AI Artifact Taxonomy) |
| AI 调用 | 0 | Layer 3: ~6500 视频/天 × 15s = 2.3h GPU |
| 入池耗时 | < 2s/视频 | 6-36s/视频 (Validator) |
| ShotPool | 共享 | 共享 |
| Scheduler | 共享 (Tag+Slot) | 共享 (Tag+Slot) |
| Renderer | 共享 (ffmpeg) | 共享 (ffmpeg) |
| Review | 共享 | 共享 + 灰区审核队列 |

---

## 9. 性能估算

### 单批次处理时间（20 个 AI 视频）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| Prompt 解析 | < 1ms × 20 | 可忽略 |
| Validator Layer 1 | < 1s × 20 | 20s |
| Validator Layer 2 | < 5s × ~18 | ~90s（Layer 1 淘汰 ~2） |
| Validator Layer 3 | 15s × ~13 | ~195s（Layer 2 淘汰 ~5） |
| Validator Layer 4 | < 1s × ~10 | 10s |
| 入池 | < 1s | 可忽略 |
| 调度 | < 100ms | 可忽略 |
| 渲染 | 30-120s/产品 | 30-120s |
| **总计** | | **~5-7 min** |

### 每日产能（10000 AI 视频 + 3 GPU）

| 阶段 | 处理量 | 并行度 | 总耗时 |
|---|---|---|---|
| Layer 1 | 10000 | 10 Worker (CPU) | ~17 min |
| Layer 2 | ~9200 | 10 Worker (CPU) | ~77 min |
| Layer 3 | ~6500 | 12 GPU 路 (3 GPU × 4) | ~2.3 h |
| Layer 4 | ~4500 | 10 Worker (CPU) | ~8 min |
| 灰区审核 | ~500 | 1-2 人 | ~83 min |
| 调度 | ~4000 通过 | 1 Worker | < 1 min |
| 渲染 | 500 批次 | 10 Worker | ~8 h |

**瓶颈分析：**
- GPU (Layer 3): 2.3h → 无瓶颈
- CPU (Layer 1-2-4): ~1.7h → 无瓶颈
- 渲染: 8h → 主要瓶颈，但可通过增加 Worker 线性扩展
- 人工审核: 83 min → 1-2 人即可

**10 Worker 日产能：500+ 批次，不受 GPU 限制。**

---

## 10. 核心问题回答

### "如果未来 90% 广告素材来自 AI 视频，系统最大的竞争力应该是什么？"

**回答：是的，AI Video Validator 是系统最大的竞争力。**

但需要补充三点：

**1. Validator + ShotPool + Scheduler 是组合壁垒，不是单点。**

Validator 过滤废片 → ShotPool 积累可用镜头 → Scheduler 按脚本组合。三者缺一不可。但 Validator 是其中最难复制的——ShotPool 和 Scheduler 的逻辑 1 周可以复制，Validator 的标注数据和调参经验需要数月。

**2. Validator 的护城河随时间加深。**

- 第 1 个月：用 Codex 做 Layer 3 的 bootstrapping，准确率 ~75%
- 第 3 个月：积累 9 万条标注，训练专用模型，准确率 ~85%
- 第 6 个月：积累 18 万条标注，模型迭代到 v2，准确率 ~92%
- 第 12 个月：25 万条标注，Cascade 调优完成，准确率 ~95%

竞争者在第 12 个月开始追赶，需要同样 12 个月才能到 92%。

**3. Validator 的终局不只是"过滤废片"。**

当 Validator 准确率足够高时，它可以反向指导 AI 生成：
- 统计发现 "Runway 生成 close-up 的手部异常率 30%，Kling 生成 close-up 的手部异常率 8%" → 指导生成平台选择
- 统计发现 "prompt 包含 'detailed hands' 时手部异常率降低 40%" → 优化 prompt 模板
- 统计发现 "zoom_in 镜头做 Hook 的成片满意度比 static 高 35%" → 优化 Slot 模板

**Validator 从"废片过滤器"进化为"生成策略优化器"。这才是它的终局价值。**

---

## 11. 实施路线建议

### Phase 1: Prompt Parser + Validator Layer 1-2（1-2 天）

- `prompt-parser.mjs`: 正则映射
- `ai-video-validator.mjs` Layer 1: ffmpeg 技术检测
- `ai-video-validator.mjs` Layer 2: 光流/方差检测
- 接入 processor.mjs 的 AI 视频处理分支
- UI 显示 Validator 结果统计

### Phase 2: Validator Layer 3 (AI) + 废片桶（2-3 天）

- Layer 3a: Product Consistency（首中末帧对比）
- Layer 3b: Human Anomaly（手/脸/肢体）
- Layer 3c: Scene Stability（背景/物体）
- 废片桶存储 + 统计 UI
- 初期用 Codex 做 Layer 3（bootstrapping）

### Phase 3: Validator Layer 4 + 灰区审核（1-2 天）

- Layer 4: Ad Suitability（产品可见度/构图/Hook）
- Human Review Queue 存储 + UI
- 灰区审核流程

### Phase 4: 双 Pipeline 集成（1 天）

- Real + AI 混合批次支持
- ShotPool origin 字段
- Review UI origin 标签
- 端到端测试

### Phase 5: 专用模型训练（持续，不阻塞生产）

- 收集标注数据（Layer 3 Codex 输出 + 人工灰区审核）
- 训练专用 artifact 检测模型
- 替换 Codex → 专用模型
- 持续迭代 Cascade 阈值

**总计 Phase 1-4: 5-8 个工作日可上线。Phase 5 持续进行。**

---

## 12. 设计决策总结

| 决策点 | 选择 | 理由 |
|---|---|---|
| AI 视频是否需要 scene detection | ❌ 不需要 | AI 视频是单镜头 |
| AI 视频是否需要语义分析 | ❌ 不需要 | Prompt 已包含所有语义 |
| AI 视频如何获取 tags | Prompt 正则解析 | 0 成本，100% 准确 |
| Validator 架构 | 4-layer cascade | 便宜检测先淘汰大部分废片，贵的 AI 只跑存活的 |
| Layer 3 模型选择 | 初期 Codex，终期专用模型 | 数据飞轮 |
| ShotPool 是否需要区分 Real/AI | 只加 origin 字段 | Scheduler/Renderer 不需要知道 |
| 灰区处理 | 人工审核队列 | 5-10% 的量，1-2 人可覆盖 |
| 废片桶 | 保留所有 reject 视频 + reason | 标注数据 + 平台/prompt 分析 |
| AI 在系统中的角色 | Layer 3 Artifact 检测 + 离线训练 | 不在调度/渲染路径上 |

---

## 结论

**V2 解决了"实拍素材怎么最快产出广告"。**

**AI Footage Pipeline 解决了"AI 素材怎么安全进入生产系统"。**

**AI Video Validator 是两条 Pipeline 汇合点上的守门人——它的准确率直接决定了 ShotPool 的质量上限，进而决定了成片的质量上限。**

当 90% 素材来自 AI 时，所有人都能生成视频，但不是所有人都能自动筛选出好视频。**能筛选的那个人，赢。**
