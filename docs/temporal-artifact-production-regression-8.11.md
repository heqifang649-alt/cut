# 8.11 开箱：真实生产 Artifact 回归审计

## 结论

**BLOCKED。** `ENABLE_ARTIFACT_GATE` 保持未设置（代码仅在值严格等于
`"true"` 时开启）。本次不能声称已解决 AI 穿帮，也不能开启生产 `REJECT`。

两条真实成片的异常均已追溯到原始素材，属于 **source-side
Artifact**，不是转场、裁切、字幕或重新编码生成的 render-artifact。当前
Analyzer 对两个正样本的精确 `hand_object_detachment` Recall 为 **0/2**；在本
次七段真实 Golden 子集的精确类型/时间评分中，Precision 为 **0/11**。样本很
小且仍有覆盖缺口，因此这些数字不是可泛化的模型指标，只是不得上线的失败证据。

## 追溯结果

批次：`726636a1-50f8-45eb-9a33-4c1f641d7efa`（`8.11开箱`）。三个产物均由
`edit/batch-edl.json` 以 `speed=1.0` 和 `hard_cut` 渲染；原 `render-manifest.json`
记录 15 个硬切、零转场。

| 成片 | 原始素材与 EDL 段 | 人工确认源异常 | 成片对应时间 | 来源 |
| --- | --- | --- | --- | --- |
| `TT1.mp4` | `products/TT1_M1 (4).mp4`，源 `1.40–4.40s`，成片 `9.70–12.70s` | 白色手机与手脱离/悬空 `1.50–2.25s`，手工轨道 `manual:TT1_M1_4:phone-1` | `9.80–10.55s` | source-side `hand_object_detachment` |
| `TT2_M2.mp4` | `products/TT2_M2 (3).mp4`，源 `3.00–6.20s`，成片 `5.00–8.20s` | 黑色手机在男子转身后悬空 `5.50–6.15s`，手工轨道 `manual:TT2_M2_3:phone-1` | `7.50–8.15s` | source-side `hand_object_detachment` |

二者**不是同一个原始文件、同一个 Shot 或同一个产品**；共同点是同一类源端
手物脱离被 Legacy EDL 直接选入。`TT2_M1.mp4` 未被人工确认存在本类异常。

## 人工真值与证据

真值由原始视频连续帧人工确认，而不是由 Analyzer 候选反推。完整事件、bbox、
轨道、时间、`shouldReject=true` 和 EDL 映射保存在：

`D:\codex\tmp\cutflow-8.11-artifact-audit\manual-evidence\manual-confirmed-events.json`

| 事件 | previous | anomaly | next | bbox（归一化） | 3 秒证据片 |
| --- | --- | --- | --- | --- | --- |
| TT1 手机悬空 | `1.33s`，可见手持 | `1.75s`，手与手机分离 | `2.17s`，同镜头内仍分离 | `(0.585, 0.245, 0.145, 0.125)` | `tt1-phone-detachment-context.mp4` |
| TT2_M2 手机悬空 | `5.17s`，可见手持 | `5.50s`，转身后悬空 | `5.83s`，同镜头内仍悬空 | `(0.079, 0.229, 0.241, 0.294)` | `tt2-phone-detachment-context.mp4` |

同目录有 `tt1/tt2-*-prev.jpg`、`*-anomaly.jpg`、`*-next.jpg` 和 12fps 连续帧
拼图。手工真值本身没有 suppression reason；Analyzer 对应候选的 suppression
reason 另列于下文。

## 实际 Analyzer / Gate 结果

运行环境是实际安装的 MediaPipe 0.10.32、XNNPACK **CPU**。未使用 GPU；未引入
新的外部模型。输入为原始 MP4 连续解码帧，输出为逐帧对象/手/pose、track、时间
段、bbox、previous/anomaly/next 与 context clip。MediaPipe runtime 为 Apache-2.0；
精确下载的 `.tflite` / `.task` 资产许可证尚未独立核验，故仍为 evaluation-only。

连续三次、6fps、同模型哈希的分析语义哈希完全一致：

| 源 | Run 1 / 2 / 3 语义 SHA-256 | 实际候选 | 与真值的差异 |
| --- | --- | --- | --- |
| `TT1_M1 (4).mp4` | `a3f3045e…6a98c7`（三次相同） | `object_disappearance` `1.16667–2.00s`，`possible_hand_occlusion`，置信度 `0` | 没有输出 `hand_object_detachment`；只覆盖真值的一部分且分类错误 |
| `TT2_M2 (3).mp4` | `7c5745c6…cde3aa`（三次相同） | 手机 `object_disappearance` `5.00–5.83333s`，`fast_camera_motion`，置信度 `0.18796`；另有杯子误候选 | 没有输出 `hand_object_detachment`；时间段与真值仅部分重合 |

隔离 `validateWithArtifactGate`（Run 4）产生的正式决策：

| 源 | Gate verdict / reason | 真正依据 | Validator verdict |
| --- | --- | --- | --- |
| `TT1_M1 (4).mp4` | `REVIEW / object_disappear` | 被 `possible_hand_occlusion` 抑制的 `1.1667–2.0s` 候选 | `REVIEW` |
| `TT2_M2 (3).mp4` | `REVIEW / object_spawn` | `7.0–7.8333s` 的手机出现候选（不是真值事件） | `REVIEW` |

因此 Gate 能保存候选 Evidence 并将不确定性转为 REVIEW，却没有正确识别该事件，且
evaluation 模式按设计不会自动 REJECT。

根因不是“泛称模型能力不足”，而是：

1. `temporal-artifact-analyzer.py` 的同帧关系仅在 bbox `overlaps_or_near` 时写
   `state: "attached"`，不会写 `detached` 或 `floating`；在 TT1 的悬空帧，宽松
   手框仍被关联为 attached。
2. `hand_object_detachment` 只接受“同一稳定 object track + 同一稳定 hand track”
   的 attached→separated 转换。实际手机检测置信度低、轨道重关联/缺失，条件不成立。
3. 手机消失候选被 `possible_hand_occlusion` 或 `fast_camera_motion` 正确降级为
   REVIEW；但没有独立的“对象在画面中仍连续可见、手却离开”的时序证据来恢复置信度。
4. 当前对象类别仅为 `person`、`cup`、`cell phone`；衣服图案、配饰、家具、背景和
   产品本体不在目标类。`human_anatomy_anomaly` 目前明确不产生 episode。

## Golden Dataset 与真实测量

`tests/fixtures/golden-dataset/temporal-artifact-v1.json` 已固定七段真实素材：

- Positive：上面两个 8.11 开箱手机手物脱离事件（每项含人工 type、start/end、object、
  trackId、bbox、`shouldReject` 与 Evidence）；
- Normal：两段正常手持手机开箱素材及一段正常书本素材；
- Hard Negative：真实快速身体运动，以及 `TT2_M2 (2).mp4` 正常持机/转身。该后者
  仍被系统报出水杯候选，已证明为误报。

`D:\codex\tmp\cutflow-8.11-artifact-audit\golden-run-1\report.json` 的精确类型且
时间重叠评分如下：

```text
all candidates:       TP 0, FP 11, FN 2, precision 0.0, recall 0.0
reject-eligible only: TP 0, FP 3,  FN 2, precision 0.0, recall 0.0
```

这不是通过修改真值、降低阈值或把 REVIEW 改为 ACCEPT 得出的通过结果；恰恰相反，
正样本被正确地保留为 `hand_object_detachment`，所以当前能力不合格。

覆盖仍不完整：尚未收集并人工标注的“正常镜头切换”和“正常手机出画”Hard Negative；
故不能声称这两类已无误杀。

## 为什么生产没有拦截

生产批次没有 `artifact-evidence.v1.json`、`validation-results.json`、`shot-pool` 或
`schedule-result.json`。`.env.local` 未定义 `ENABLE_ARTIFACT_GATE`，而
`isArtifactGateEnabled()` 仅接受严格的 `"true"`，因此历史生产走了 Legacy 路径：

```text
raw products → 外部 Agent 直接写 batch-edl.json → renderBatchFromEdl → output
```

`processor.mjs` 还允许检测到已有 `batch-edl.json` 后直接恢复本地渲染；该恢复路径
不会补跑 Gate。故这个批次确实绕过了 Artifact Gate → ShotPool。

对该历史批次做隔离 ShotPool 回放也不能作为准入证明：
`importBatchToShotPool` 在调用 Validator/Gate 前强制读取 metadata sidecar，而 12 条
真实产品源均返回 `METADATA_SIDECAR_NOT_FOUND`，全部被 skipped。该事实记录在：

`D:\codex\tmp\cutflow-8.11-artifact-audit\gate-shotpool-run-1\shot-pool-import.json`

## Run 5 / Run 6

- **Run 5（Scheduler → EDL）BLOCKED：** 该历史批次没有 ShotPool、ScheduleResult 或
  metadata sidecar；Legacy Agent 写入 EDL 的选择输入也未持久化。不能在不伪造 Shot
  metadata 或改写生产数据的条件下复现 Scheduler→EDL。
- **Run 6（Clip → Render）PASSED as reproduction, not as quality approval：** 在
  `D:\codex\tmp\cutflow-8.11-artifact-audit\rerender-run-1\batch` 从真实 EDL 重新
  切出 15 段、硬切、合成三条成片并做解码 QC。TT1 `10.05s` 与 TT2_M2 `7.50s` 的异常
  均仍可见，确认不是 Render 阶段生成。

## 最小改造方案（尚未实施）

不改 Pipeline、Shot、Slot、Product View、Scheduler、RenderPlan 或 EDL Contract：

1. 在现有 `validateWithArtifactGate` 的证据 schema 内增加**接触状态序列**：以手掌/指尖
   到对象边缘的距离、对象可见性和连续 track 为证据，显式写入 `attached`、`separated`、
   `occluded`、`unknown`；单帧或 unknown 只能 REVIEW。
2. 为低置信手机检测增加短暂 track bridge（保留原 detector score），但只在无 shot
   boundary、无正常遮挡且对象持续可见时生成 `hand_object_detachment`。连续 ≥3 帧、
   多证据高置信才成为 REJECT candidate；其余保留 REVIEW。
3. 修复 ShotPool 导入的真实 metadata sidecar 前置依赖：在 Source Artifact Gate 已完成
   后再计算/补齐真实 metadata，不得因为缺少 sidecar 跳过 Gate；并拒绝将非 ACCEPT 的
   source 写入池。
4. 在 Legacy EDL 恢复/渲染入口增加**只读 provenance preflight**：EDL 每个 source 必须
   有同 SHA-256 的 ACCEPT Gate 记录；缺失记录为 REVIEW/阻断渲染。该约束不改变 EDL
   contract，只阻止 raw-products 旁路。
5. 将本批两个正样本设为不可删除的回归门槛。只有它们被准确定位为
   `hand_object_detachment`，且新增正常快速运动、遮挡、出画、镜头切换真值均不过度
   REVIEW/REJECT 后，才单独评审开启生产 REJECT。

## 十项验收回答（当前状态）

1. 手机悬空：**否（BLOCKED）**；有错误类别的 REVIEW 信号，不是可靠检测。
2. 水杯消失：**否（BLOCKED）**；真实正常段已有水杯出现/消失误报，未有人工正样本。
3. 手物脱离：**否（BLOCKED）**；两条真值均漏为正确类型。
4. 正常快速运动：**未误 REJECT，但会误 REVIEW；未通过。**
5. 镜头切换：**未验证。** 代码有 suppression，真实标注集尚缺该类。
6. 遮挡：**未误 REJECT，但会误 REVIEW；未通过。**
7. 异常时间段：**部分能。** 两个候选与真值部分重合，但类别/边界不准确。
8. Evidence：**能。** 手工真值与 Analyzer 候选均有 previous/anomaly/next、bbox、时间和
   3 秒 clip。
9. ACCEPT / REVIEW / REJECT：**不符合生产预期。** 当前真实正样本为 REVIEW；evaluation
   模式没有自动 REJECT，历史生产还完全未执行 Gate。
10. Recall / Precision：**在此真实七段子集均为 0.0 / 0.0（2 个正事件，11 个候选）**；
    不能用于通过验收或打开生产开关。
