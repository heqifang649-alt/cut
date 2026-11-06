# Hook / CTA / BGM 品牌隔离核查（2026-11-02）

结论：已定位生产旧路径、品牌传递缺口及资源缺失，已完成开发侧最小修复与共享渲染器隔离验证。没有部署或启用生产。不能宣称三条入口的浏览器到 MP4 全链路验收通过。

## 当前生产与历史依据

- 实际进程运行于 `D:\CUT-Releases\20261030-production-first-r11`，Web BUILD_ID `jBLQ22K9cTC7micSQYXlC`。以进程和冻结文件最新补充为准，不能使用根 AGENTS 中过期的 r0 描述判断运行版本。
- `35e2343` 已将品牌模块及配置纳入历史提交；本次修改前，release 的 brand-bgm、brand-copy-library、brand-copy-match、libtv-bridge 和两份品牌配置与工作区逐文件哈希相同。不是这些模块完全没发布，也未发现近期修改这些模块的回归提交。
- 品牌文案启用条件为 batch.brandCopyEnabled 或 ENABLE_BRAND_COPY_LIBRARY=true；品牌 BGM 为 ENABLE_BRAND_BGM=true。release .env.local 和启动脚本未找到启用配置。没有直接读取运行进程的私有环境，因此不把配置文件缺席单独当成进程环境的最终证明。
- 更强的运行证据：生产已完成单源 TT `a28a04b4-581a-46fa-bd81-d7505219d3bc`、多源 TT `d797e12b-4308-46d3-b3f3-6ee1093c73bb`、多源 GC `80687ac9-6a97-48de-a0ae-dbe777d443d2`，检查点都使用同一模板 `73afa4b6-028c-49cd-af57-f34cc4d99cf0/template-bgm.m4a`，且没有 brandCopy / bgm 决策。运行结果证明这些任务没有走品牌选择路径。
- 2026-10-21 的 `artifacts/brand-bgm-20261021/ACCEPTANCE.md` 明确要求保持开关关闭，直到 GC/TT 补库、听审及用户批准。历史文案刷新报告也明确生产默认关闭。因此应分类为“功能已集成但未启用 + 接线缺口 + 缺库”，不能仅称代码回归。

## 三条链路分别追踪

| 链路 | 品牌入口与传递 | RenderPlan 到 MP4 的实际行为/断点 |
|---|---|---|
| Hybrid 网页 | app/page.tsx 创建请求没有 brandCopyContext、site_id、brand_id；API batches/route.ts 接受 trustedCopyContext，但网页没有提交它；store.ts 会保留已传入上下文 | 分析/ShotPool/语义/Scheduler 产出镜头计划，batch-renderer 独立加载批次上下文。默认关闭时 Hook/CVR 来自 batch 覆盖或 referenceProfile，BGM 可固定为模板。不是 Scheduler 改品牌就会自动换资源 |
| classic 旧单源 bridge | descriptor.siteId 与 manifest.source.site_id 验证租户身份；siteId 不会自动映射 GC/TT/NW。libtv-bridge 从 manifest.brand_copy 或 source.brand_id 构造 verified_handoff 上下文。旧 LAN guided 分支显式跳过该构造 | 模板/库音乐以及文案仍受独立开关影响；本次移除 guided 跳过品牌传递的条件。没有推断 site UUID 的品牌含义 |
| classic unified v2 单源 | v2 manifest 允许 sources.length=1；品牌取 sourceBinding.value，不通过旧 bridge；生产实例为 tokyotiger | classic-multisource-context 构造模板 rendererBatch，executor 重新构造批次却原先没有将 record.sourceBinding 转成品牌上下文。即使启用开关也不能据此正确取库 |
| classic 多源 | v1 至少 2 源，v2 允许 1–8 源；sourceBinding.kind=brand 时校验每源 brandIdentity 与 binding.value 一致；产品绑定不能冒充品牌绑定 | 每源分析/质量证据→分组与调度→renderBatchFromRenderPlans→EDL→共享 batch-renderer。与 v2 单源共享 executor，但镜头数量、分组、质量及调度路径不等同；同样存在品牌上下文缺口 |

本仓库无法访问 classic 服务端网站的实时前端选择状态及其站点注册表；本地 LibTV 下载扩展不是该服务端网站。未验证“用户在 classic 页面切换站点后实际发出的每份 manifest”，不虚构 site_id→brand_id 映射。生产已有 sourceBinding 为 guidingcross/tokyotiger 的记录，说明至少这些任务在交接记录层已经携带不同品牌。

## NAS、文案及缓存

- 当前 Windows 会话可直接列举 UNC `\\192.168.120.60\新成片交付\批量剪辑素材\BGM`，无需盘符映射；品牌目录映射 GC→基督，TT→亚文化，NW→暗黑，与约定相符。可列举/读取不等于所有服务账户具有相同 ACL；未修改权限。
- GC/TT 目录可读但媒体数都是 0；NW 递归统计可识别媒体 279（238 MP4、41 MP3），另有 1 个非媒体文件。NW 实际解码成功；不能把空目录解释为认证失败。
- 本次直接读取 NAS 最新三份 Excel：GC 37 Hook / 0 CTA；TT 55 Hook / 11 CTA；NW 55 Hook / 55 CTA。工作簿 SHA256、sheet、row 随选择记录保存；计数不代表每条都满足场景、声明和时长限制。
- 索引按显式文件映射建立，候选按 brand 精确过滤；不扫描健身库推断品牌。每批 snapshot 冻结，运行中不刷新属于可复现设计；新批重新读取 NAS，失败时使用同文件名的 last-good cache 并记录警告。
- output-copy 按输出 ID 建目录，selection fingerprint 含 batchId、产品、品牌上下文和锁定文案。未发现已验证的跨品牌选择缓存复用。旧结果重试复用和同品牌确定性排序可能正常产生相同文案。
- 原文案匹配末尾允许无归属 template 文案回退，空库可被模板掩盖。本次取消这一路回退。明确指定的 locked 文案及品牌上下文内 script 保留原优先级，来源分别标记 locked/script；不是强制每次文字不同。
- 品牌 BGM 使用 crypto.randomInt，在同品牌同目录映射缓存内避开上一首。单曲允许重复，多个 worker 同时选择仍可能重复；这是尽量避重，不是全局不重复承诺。NAS 不可用可回退同品牌缓存，不借用其他品牌；无可用曲保留原音或静音，并输出 BGM_NO_VALID_TRACK 等告警。

## 本次最小开发修复

1. classic executor 将经验证的 brand sourceBinding 写成 verified_handoff 品牌上下文，覆盖模板中的全局品牌；未知 binding 保留未知身份，不能继承模板品牌。
2. 旧 LAN guided bridge 保留经验证的交接品牌上下文。
3. canonicalBrand 统一接受 NW（此前 copy 与 BGM 对 NW 的处理不一致，但 matcher 原有 raw-value 路径可处理大写 NW，不能断言这是本次现象的主因）。
4. 空库/无匹配文案禁止模板回退，省略并记录 BRAND_COPY_NO_MATCH。

不修改开关、Quality Gate、Scheduler、历史任务或生产文件。工作区已有的 renderer/short-shot/Scheduler 修改在本次开始前就存在，不纳入本补丁，也不得顺带部署。

后续最小上线包还需：补齐网页品牌选择/提交及 classic 站点身份映射证据；明确对每个入口的启用范围；GC/TT 补 BGM、GC 补 CTA 或接受显式省略；完成实际入口隔离矩阵及批准后启用。直接全局打开开关会让未传品牌的请求无库可用，不能作为单独的修复。

## 实际验证与证据边界

证据目录 `E:\cutflow-brand-isolation-20261102`，复现脚本 `scripts/audit-brand-isolation.mjs`。所有测试缓存、快照、音频及 MP4 写入隔离根；没有提交 Provider 调用。

- 同一真实输入、相同镜头 EDL，分别 GC/TT/NW，使用共享 renderBatchFromEdl 真正编码 MP4。场景语义使用明确标注的受控 fixture；不冒充重新执行生产 Quality Gate。
- GC Hook：`Christian clothing doesn't have to be boring.`，来源基督.xlsx / GC Hook总库 / 第 3 行。CTA 为空并告警。
- TT Hook：`THIS HAS BEEN ON REPEAT LATELY`，来源亚文化.xlsx / Tokyo-Tiger Hook库 / 第 18 行；CTA 来源同表第 60 行。
- NW Hook：`A PRINT YOU DON’T SEE EVERYWHERE`，来源暗黑.xlsx / 暗黑标题 / 第 46 行；CTA 来源暗黑引导语第 53 行。
- 三个 MP4 全量解码通过，Hook 实际帧已经视觉核对。每个条目的 ID、原文、品牌与新鲜 NAS 索引匹配。CTA 抽帧也已保存。
- 解码音轨 GC/TT RMS=0（该输入无原音）；NW RMS=0.2561，与所选曲在 ±1024 个 16kHz 采样内补偿编码/滤镜延迟后，最大相关系数 0.98362。不是只比较文件名。见 audio-verification.json。
- NW 连续两次选择曲名不同；随机避重机制单元测试覆盖多曲/单曲/空库。GC/TT 的相同静音音轨是缺库策略生效，不能误判为跨品牌串曲。
- 品牌定向测试 15/15；品牌+guided 回归当时 55/55（之后新增 1 条空库模板隔离测试，单独重跑通过）；classic executor v1 两源、v2 单/双/三/八源 5/5 真 FFmpeg 编码/发布测试，新增断言确认 verified_handoff TT 到达 renderer。
- classic contract+bridge+executor 合并回归 33/34；失败为旧 bridge 的 post-batch crash recovery，测试把字符串当 MP4，预期输出数 1，实际 0。同一用例替换为未修改 release 全部 lib 导入后仍同样失败，见 baseline-bridge-tests.txt。未为了通过修改生产验收。
- 修改文件 ESLint 0 错误；最终去除未使用参数后的定向 lint 无告警。未做完整 Web build，也未声称发布候选整体 READY。

本次证据证明共享渲染器按品牌取库，以及 classic 单/多源修复将品牌传到 renderer。它不等于 GC/TT/NW × Hybrid/classic 单源/classic 多源的九格真实浏览器入口全部通过；也没有重跑或覆盖历史生产 MP4、做现场听审或独立业务验收。生产启用必须另行批准。
