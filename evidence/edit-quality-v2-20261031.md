# CUT 真实剪辑质量诊断 V2 · 离线候选，未验收

日期：2026-10-31。任务 bb95f01f-9b95-4e11-bd94-0d6e7b39cb7d；Batch 1494e2c7-2a38-439d-b45f-05b4846d3332。

## 生产核对

实际可读运行主机为“尔尔”，Web PID 456112、多源 runner PID 458940，均指向 D:\CUT-Releases\20261030-production-first-r11；BUILD_ID jBLQ22K9cTC7micSQYXlC。运行时 workRoot 为 E:\cutflow批量。任务记录 completed，生产成片 SHA256 dcb64e71391ba71ef89c2018f2217563c614bd6d34393fafbc1d5cffc6cf8fa1，10.5 秒。发布目录 data/storage 是历史发布数据目录的链接；本轮只读，未修改生产。

不能把开发 HEAD 20bb660e2ed0e885b7a051a4f336d27ae3d92032 声称为完整生产 Commit。治理记录给出的发布源码锚点为 4c0a8cf，后有 4de2458、e6b9ba6 等覆盖；当前 BUILD_ID 又与文档不同，无法仅凭这些记录确定唯一完整生产 Commit。相关模块实际 SHA256、进程信息保存在 runtime-readonly.json。修改前 scheduler、quality 的发布文件与开发文件哈希一致。

## 真实 EDL 映射

A = 原始顺序 01-37967a8e；B = 原始顺序 02-ed87291a。两者均约 10.04 秒。以下角色是模板标签，不能冒充已验证的画面语义。

|成片时间（秒）|来源|原片时间|槽位|实际选择依据|
|---|---|---|---|---|
|0–2.170|B|0–2.170|hook|early 窗口；同起始时间确定性排序胜出；无语义评分|
|2.170–3.921|A|0–1.751|outfit_interest|A 起点 0 小于 B 后续窗口 3.42|
|3.921–5.848|B|3.420–5.347|front_reason|middle 窗口按时间及确定性排序|
|5.848–7.424|A|3.420–4.996|sleeve_fabric_reason|A middle 早于 B late|
|7.424–10.470|B|6.840–9.886|back_or_best_reason|late 同起点排序；该候选带 quality:review|

EDL 合计 10.47 秒，编码成片 10.5 秒。全部 1.00×、硬切。六个候选均是 3.2 秒采样窗口（0–3.2、3.42–6.62、6.84–10.04），并非动作识别分段；窗口间各漏掉 0.22 秒。画面抽帧见 source-1.jpg、source-2.jpg、production.jpg。原片有相近的正面、细节、转身、回正结构；成片重新从另一原片开头进入，并重复细节信息。这是可见的叙事重复；动作完成边界仍需连续播放判断，不能由每秒抽帧确认。

## 确定根因与边界

1. worker/shot-scheduler.mjs：preserveSourceOrder 的过滤器仅保证各源内部不倒退，排序却把不同文件的局部起点混为共同时间线，优先于语义和其他评分。可复现、有定向测试。
2. worker/classic-multisource-quality.mjs：返回 receipt/shotPool/report，不返回 semanticEvidence。现有证据是商品一致性、伪影、可用性，不包含 shot_type/hook_value/动作边界/新增卖点；不能伪造语义值填充。renderer 的 productVisualReview 明确 not_run / semantic_evidence_unavailable。这是现有能力缺口，不能断言真实语义曾成功运行后被丢弃。
3. 五槽模板全部 requireTags=[]；front/detail/back 标签没有对应语义验证。3.2 秒候选被固定槽位裁短。降低短镜头次数并不能自动解决叙事问题。
4. worker/classic-multisource-executor.mjs：模板适配失败后旧兜底会按原片顺序拼入所有可用候选，容易串联相似完整拍法。离线首轮暴露该行为，因此增加有限兜底修正。
5. worker/classic-multisource-context.mjs 从选定模板继承 profile 与 template BGM；worker/batch-renderer.mjs 的 buildRenderPlanMaster 继承 hook_text/cvr_text。真实 EDL 是 “This has my go-to style lately...” / “Don't wait on this one.”；render-manifest 音乐为 template-bgm.m4a。这不是经典版导演意图证据。本轮已查明来源，尚未修改文字策略。

## 最小候选修改

- 时序过滤不变，取消跨源局部时间的绝对优先级。保留语义/偏好排名；quality:review 软扣 0.1，跨源软扣 0.05。更有价值的语义候选仍可跨源并返回，不设置镜头数量上限或新拒绝门槛。这些数值是待 A/B 验证的候选参数，不是验证过的审美标准。
- 仅在原有兜底分支，若某一原片已提供 8–13 秒候选，优先使用一个待复核片段较少的完整候选序列，避免把替代拍法串接；无可用序列仍保留原兜底。正常模板成功路径仍允许多源。
- 本案例候选为 A 的 0–3.2、3.42–6.62、6.84–10.04，输出约 9.6 秒。开头模糊、采样空隙仍在；未声称动作完整性已经解决。未修改经典版、协议、分组、Provider 或生产默认。

## 离线验证

comparison.json 保存 8 对真实旧/新成片及双方逐镜头时间线，含单源和多源；另一个历史样本因调度结果不能形成有效 RenderPlan 被排除，未计入有效样本。所有回放输出写入本目录，历史输入与成片未覆盖。没有模型调用。采用真实 renderer，并保留生产音轨及文字作为控制；回放 profile 是部分重建，因此并非完整生产上下文复制，不能把差异全归因于排序。没有重新生成视频素材。

blind-review.html 提供交错左右顺序的本地播放包（需在浏览器打开）；blind-review-key.json 是揭盲对应表。此为简易人工盲评包，未宣称严格随机实验。评分权重：吸引力 25%、展示 30%、衔接 25%、节奏 20%。分数、偏好均留空；尚无人工评分和偏好率，不满足 70% 验收证据。

定向及相关回归 120 项：118 通过、2 失败（final-tests.txt）；新增 3 项测试均通过。两个失败分别是既有 partial-hook 断言与未修改的 shadow scheduler-v2 时长断言。前者已用 HEAD 模块复测为原有失败（baseline-tests.txt）；后者所属实现及依赖均未修改、独立复测同样失败（v2-unchanged-baseline.txt）。没有修改旧断言掩盖结果。单/多源真实 FFmpeg 集成覆盖 1/2/3/8 源。ESLint 定向通过；git diff --check 通过。未运行生产构建或生产接单 canary。

## 结论与剩余事项

诊断与有限离线候选已产生，整体质量修复尚未完成，质量验收未通过；不得部署。不能用测试通过数或较少切换替代真实观感判断。

尚缺：人工对 8 对视频的四维评分及严重缺陷检查；可复用的逐镜头景别、商品新增信息、动作起止/完成度、跨源接续依据；显式创意文案授权与结尾意图。当前协议并未证明携带这些字段；本轮未扩经典版接口。继续堆加排序惩罚不能替代这些证据，因此先停在可审阅的离线候选，不扩大规则。

部署状态：未部署，未重启服务、改计划任务或回传；生产回滚无需执行。候选代码只在开发 Git；如放弃，只需反向撤销本轮候选 commit，不触碰发布目录与历史素材。
