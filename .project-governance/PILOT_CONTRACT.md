# Cutflow Hybrid Pilot — 精简执行合同 v2.0

**状态**：ACTIVE / REQUIREMENTS_FROZEN
**更新日期**：2026-08-14 (Asia/Shanghai)
**治理角色**：Root Codex 是本 Pilot 的 PM、执行编排和集成验收权威。
**适用范围**：Cutflow 批量服装广告生产路径的受控迁移与交付。

## 1. 冻结目标与边界

本合同的目标不是证明某个模型在研究意义上优于所有替代方案，而是用最小充分证据，使已确认素材能够稳定、可回滚地批量生产。

已冻结的产品边界：

1. **正常路径**：确定性分析 → ShotPool → Provider 语义评分 → 确定性 Scheduler → RenderPlan/EDL → FFmpeg Renderer → 多层 QA。
2. **Codex 定位**：仅用于首次样片母版分析、产品分组异常、低置信/高风险任务、开发、调试和规则迭代。已确认母版与产品分组的正常批次不得要求外部 Codex session 才能继续。
3. **Provider/模型**：Pilot 和首个生产候选冻结为 `gpt-5.6-sol`。Gemini、Qwen 或其他模型比较属于非关键路径附录，不能阻塞本 Pilot。
4. **发布方式**：先运行 3–5 个真实批次的受控 Canary；每批可自动或人工回退到 Control A。Canary 证据通过后，才允许将 Hybrid 设为默认正常路径。
5. **Control A**：现有 Codex/Skill 生产路径必须保留、可运行、可回退；在 Hybrid 默认切换后仍保留一个完整回滚窗口。

本合同不授权删除现有生产路径、不授权修改 Gold Standard 以规避失败，也不授权把 Provider 凭证提交或发送到 Git、日志、artifact、prompt 或客户端 payload。

## 2. 术语与状态真源

- **Control A**：当前稳定生产路径。
- **Treatment B / Hybrid**：第 1 节所述新路径。
- **Shadow**：运行 Treatment B 并保存隔离证据，不改变交付结果。
- **Canary**：明确选定的真实批次，允许 Treatment B 交付，但受硬 QA 门和即时回滚保护。
- **严重产品错误**：产品/款式错配、关键服装主体错误、明显错误模板或其他会使广告不可用的真实性错误。
- **动态状态唯一来源**：`.project-governance/PILOT_STATUS.md`、`CHECKPOINT.md`、`TASK_DAG.md` 及 evidence 文件。本合同只描述规则，不嵌入易过期的 Gate 快照。

任何 `READY`、`PASS`、`PRODUCTION_READY` 或 `CUTOVER` 声明，必须由实际代码、测试、真实批次证据和独立复核支持；计划或合同文本本身不构成证据。

## 3. 硬性架构约束

### 3.1 确定性优先

可计算的属性必须由程序计算，不交给模型：时长、分辨率、FPS、场景边界、黑帧、清晰度、曝光、运动/稳定性、响度/节拍、文件完整性、编码和时间线一致性。

### 3.2 模型只做语义判断

Provider 只返回版本化结构化结果，例如 shot 类型、产品匹配、主体清晰度、front/back/detail、Hook、自然度、重复风险和异常标记。模型不得执行 shell/FFmpeg、修改文件、规划完整工作流或直接输出自由文本作为生产决策。

### 3.3 Scheduler/Renderer/QA 分层

- Scheduler 根据 ShotPool、硬指标、语义结果、覆盖率、去重、产品一致性和节拍确定性地产生 RenderPlan。
- Renderer 只执行 RenderPlan，不解释模型文本。
- QA 必须在交付前检查 artifact 存在性、可解码性、时长、画面、音频、字幕安全区和产品真实性；硬失败不得被 warning 降级。

### 3.4 Provider Adapter

第三方 API 只能通过统一 adapter 访问。adapter 至少负责 endpoint/base URL、鉴权、模型、图像输入、结构化 JSON、timeout、retry、并发上限、错误归一化和延迟 telemetry。业务代码不得按品牌分支。

首选配置入口可为现有管理设置页或受保护的运行时环境变量；无论入口如何，API Key 必须 write-only/脱敏显示，仅服务端可读。

## 4. 三道 Gate（替代原 P0–P5 关键路径）

### Gate 1 — 安全与回滚（Safety & Rollback）

**目的**：证明 Treatment B 可以安全运行，但不改变 Control A 的默认交付。

必须全部满足：

- Treatment B 默认关闭或明确受 feature flag 保护；Control A 可独立启动并交付。
- Provider timeout、有限 retry、request cap、并发上限、circuit breaker 或等价保护已实现并有测试。
- Secret 不进入 Git、普通日志、artifact、prompt、前端 hydration 或错误回显；日志仅保留 provider/model/request id、时间、状态和脱敏 telemetry。
- 结构化 schema、idempotency/缓存（若启用）、失败归一化和异常队列可验证。
- Scheduler、Renderer、QA 和现有相关回归测试通过；失败时不会丢失或不可恢复地改变 Control A 任务。
- 能用一个明确命令/开关立即回退到 Control A，并保留回滚快照或 tag。

Gate 1 通过只表示“可进入 Shadow”，不表示可以默认生产。

### Gate 2 — 真实素材 Shadow 质量（Shadow Quality）

**目的**：用小规模真实素材确认语义结果足以驱动排片，不把研究级数据集作为启动阻塞。

最低证据：

- 至少 1 个真实批次，覆盖主要模板/镜头类型；优先使用已确认母版和产品分组。
- 生成隔离的 semantic evidence，记录输入 hash、模板/母版版本、commit、provider/model、prompt/schema 版本、延迟、重试、Scheduler 结果和 QA 结果。
- 建立一组可追溯的人工校准样本（建议 10/5/5/5 起步；不足时记录缺口，不得伪造标注），至少核查产品匹配、镜头类型和关键异常。
- schema 失败、低置信和产品真实性风险必须进入 retry/exception，不得静默接受。
- 对 Control A 不作未经证据支持的优越性宣称；Shadow 期间不切换默认交付。

Gate 2 通过标准是：无未处理的严重产品错误，结果可被 Scheduler 消费，异常可追踪，失败可回退。精确阈值由实际素材基线和 `PILOT_STATUS.md` 记录，不预先写死 30%/25%/20% 的效率数字。

### Gate 3 — 受控 Canary 与默认决策（Canary & Cutover）

**目的**：验证真实批量生产的可靠性和业务收益。

必须运行 **3–5 个真实 Canary 批次**，每批记录：批次完成时间（P50/P95）、成功交付数、首次 QA 通过率、人工介入/返工次数、重试/超时/HTTP 错误、成本（可得时）、严重错误和回滚情况。

Canary 硬门：

- 严重产品真实性错误 = 0。
- artifact 不可播放、时间线损坏、队列不可恢复丢失 = 0。
- QA 硬门不得绕过；任何硬失败自动阻止交付并触发回退或 exception。
- Control A 回退在实际批次中验证可用；Treatment B 不能依赖 Codex 才能完成已确认批次。
- 结果不低于 Control A 的质量和可靠性；若发生明显退化，立即停止扩大范围。

默认切换条件：3–5 批 Canary 全部通过硬门，且相对 Control A 的实际业务基线至少有一项有意义改善（吞吐、批次完成时间、人工返工、失败恢复或成本），并由独立复核确认。质量相当但效率无实际改善时，保持 Canary，不扩大迁移。

切换后进入可回滚窗口；在窗口内保留 Control A、快照和完整 telemetry。窗口结束前不得删除旧路径。

## 5. 例外与降级

建议的初始置信策略（可由证据调整）：

```text
confidence >= 0.85       接受结构化结果
0.60 <= confidence < .85  强模型/有限重试
confidence < 0.60         exception（Codex 或人工）
```

产品真实性冲突、不可解释的关键字段缺失和连续 Provider 失败，不得因为成本或吞吐而放行。Codex/人工只处理例外，不成为已确认正常批次的常规 worker。

## 6. 安全、隐私与 Provider 边界

- 凭证永不提交 Git，永不写入普通日志、evidence、prompt、artifact 或客户端 payload。
- 错误信息不得打印 Authorization header 或完整请求体。
- 发送真实素材到第三方 Provider 前，必须遵守项目已有数据授权边界；无法确认授权时，将该批次标记为 `USER_DECISION_REQUIRED`。
- 第三方返回的模型名、provider id 和能力声明均视为不可信元数据，必须经 capability probe 和 schema 校验。

## 7. 证据、复核与完成声明

每个 Gate 至少保存：命令、commit、输入批次/文件 hash、通过/失败/跳过及原因、artifact 路径、已知限制和回滚结果。测试必须覆盖受影响模块，并保留仓库既有回归测试结果。

Root Codex 可以自主进行普通实现、任务拆分、重试、返工、测试、文档同步和 Gate 推进。只有以下情况才升级用户：缺少必需的第三方凭证/数据授权，或会改变本合同冻结的目标、交付范围、核心质量门、不可逆权限/成本边界。

正式交付必须由独立复核确认：

```text
Gate 1 = PASS
Gate 2 = PASS
Gate 3 = PASS
Control A = PRESERVED
Rollback = VERIFIED
Production path = Deterministic Analysis → ShotPool → API Semantic → Scheduler → Renderer → QA
Codex normal dependency = OFF (exception only)
Primary model = gpt-5.6-sol
```

网站可用性也是交付条件：生产构建必须通过；站点根页面必须可打开；未登录访问必须被正确拦截；管理员设置、批次创建、素材扫描、确认分组、队列处理和审核交付入口必须存在且通过对应回归测试。Hybrid 尚未通过 Gate 3 时，网站仍以 Control A 作为默认可用路径，不得因 Canary 未完成而阻断正常使用。

在上述证据齐全前，状态必须保持 `PROJECT_STATUS != PASS`、`PRODUCTION_CUTOVER = FALSE`。不得用单次 Demo、代码完成、测试全绿或模型自评替代真实 Canary 和独立复核。

## 8. 非关键路径附录（不阻塞本合同）

以下工作可在交付后单独开展，不得阻塞 Gate 1–3：

- Gemini/Qwen 或其他 Provider 的系统性对比（原 P1E）。
- 研究级 A/B 盲审、置信区间和大规模重复性实验。
- 删除 Codex SDK、重写无关模块、README/UI 美化和未来架构扩展。

如未来证据表明 `gpt-5.6-sol` 不满足质量、延迟或稳定性要求，再单独创建模型替换评估，不回写为当前生产前置条件。

## 9. 变更控制

本合同的冻结边界只能通过显式用户决策或新的、可追溯的风险/证据审查修改。动态执行状态不得通过复制旧快照更新本合同；应更新 `PILOT_STATUS.md`、`CHECKPOINT.md` 和 evidence。任何与本合同冲突的旧 Master Prompt、旧 P0–P5 快照或历史 Checkpoint，以本 v2.0 为准。

**执行原则**：先证明可回滚，再用真实批次验证，再扩大生产；确定性计算优先，模型只做语义，Scheduler 做决策，Renderer 做执行，QA 做最终验收。
