# GC/TT 文案与音乐正常业务启用合并候选（2026-11-03）

结论：两个真实任务均有旧模板 Hook/CTA，不是完全没有字幕。品牌字段未丢失，文案和 BGM 都被旧单任务 Canary 排除；BGM-only 又移除原音，于是形成“模板字幕+无音轨”。本轮合并前轮尚未部署的音乐独立开关方案，用一个业务开关/同一 cutoff 同步开启 GC/TT Hook、CTA、BGM，避免再出现范围错位。前轮 BGM-only 启用候选已被本候选取代，不应分两次部署。

## 逐批真实证据

### TT / 4a4e8f83-2c9a-48cc-b310-60cbe902a3b0

上游 sourceBinding=tokyotiger，来源 brandIdentity 一致。关联 CUT batchId=4c2b00a3-cae6-479a-9398-41c419db3d7a。旧 Canary 不命中；旧 checkpoint 无 brandCopy 记录，BGM=no_bgm，warning=BGM_DISABLED_NO_SOURCE_FALLBACK。Renderer 已识别品牌（旧 bgm.brand=TT），说明可信上下文已进入渲染器；原临时 batch 未单独持久化，不虚构该快照。前轮核对的本地与 NAS 输出 SHA 相同：95a805f07902da6ed9c028cb07a727bce54c96d4388df31ec8fdb9f5485f5f41。

实际原片 Hook 为 This has my go-to style lately...，CTA 为 Don't wait on this one.，四张原片抽帧已目视核对，内容与该任务 EDL master 完全相同。原片不是无字幕，而是共用了旧模板字幕。因为 useBrandCopy=false，未调用品牌 snapshot/Excel 选择分支；没有对应 output-copy 选择证据。原 MP4 只有视频流、没有 AAC/任何音轨。

新独立成片 E:\cutflow-brand-combined-20261103\4a4e8f83-2c9a-48cc-b310-60cbe902a3b0\output\tokyotiger.mp4；SHA256 33639eae7dc9d3c12be1349ae83d15b0b104f4fa7c15022eec593eceb25d2b3b；14.040000 秒，一条 AAC，完整解码通过。
- Hook 实际显示 WEAR WHAT YOU’RE INTO；来源 亚文化.xlsx / Tokyo-Tiger Hook库 / 行 4 / SHA256 5df70996a1db266cbacacc5342ad34290bf49edc3872b3c73ccc9e8cd32b7972。
- CTA 选择 CHECK IT OUT AT TOKYO-TIGER；来源 亚文化.xlsx / Tokyo-Tiger Hook库 / 行 57 / SHA256 5df70996a1db266cbacacc5342ad34290bf49edc3872b3c73ccc9e8cd32b7972；实际显示 省略；告警 [{"kind":"cta","reason":"copy_exceeds_safe_width"}]。
- 音乐 TT261021AA01.mp4，仅 TT 目录，原音不参与；最终 AAC -16.04 LUFS、-3.77 dBTP。
- 同一原 EDL 与 graded clips 只读复制，未运行 Scheduler/Provider、未改变商品或镜头结构；字幕外商品区域 SSIM=0.995388。字幕按本次要求替换，因此不声称全视频码流不变。


### GC / 10d743b1-fd2e-46a4-bcdd-2d3532fdafd8

上游 sourceBinding=guidingcross，来源 brandIdentity 一致。关联 CUT batchId=55916ccf-b246-42fb-a680-99d4852f9275。旧 Canary 不命中；旧 checkpoint 无 brandCopy 记录，BGM=no_bgm，warning=BGM_DISABLED_NO_SOURCE_FALLBACK。Renderer 已识别品牌（旧 bgm.brand=GC），说明可信上下文已进入渲染器；原临时 batch 未单独持久化，不虚构该快照。前轮核对的本地与 NAS 输出 SHA 相同：097e19f66789b353cc6a2253b6d107a726ae0bb393a637b828223cf001f9cd5a。

实际原片 Hook 为 This has my go-to style lately...，CTA 为 Don't wait on this one.，四张原片抽帧已目视核对，内容与该任务 EDL master 完全相同。原片不是无字幕，而是共用了旧模板字幕。因为 useBrandCopy=false，未调用品牌 snapshot/Excel 选择分支；没有对应 output-copy 选择证据。原 MP4 只有视频流、没有 AAC/任何音轨。

新独立成片 E:\cutflow-brand-combined-20261103\10d743b1-fd2e-46a4-bcdd-2d3532fdafd8\output\guidingcross.mp4；SHA256 9e9695b164061f98f6e38192fb6f39c6a905a1871c8fe6a9760b5e2446d8ec33；14.040000 秒，一条 AAC，完整解码通过。
- Hook 实际显示 Wear what you believe.；来源 基督.xlsx / GC Hook总库 / 行 11 / SHA256 cfae0b39ee869c18ec3630c1d2088c1d068615a988b67b171af81bb01b587792。
- CTA 选择 空；来源 无匹配项；实际显示 省略；告警 [{"kind":"cta","reason":"empty_copy"}]；BRAND_COPY_NO_MATCH。
- 音乐 SaveClip.App_AQMlpU1eRmC6wrmHdpJbQmEBk0229-WMMVS37MyXV9N10-KLVAF3gR6N9qGa0wuDrqsbMhaduRJaLpLWdBKGkFAf3a34baBipw9xnkU.mp4，仅 GC 目录，原音不参与；最终 AAC -16.06 LUFS、-4.50 dBTP。
- 同一原 EDL 与 graded clips 只读复制，未运行 Scheduler/Provider、未改变商品或镜头结构；字幕外商品区域 SSIM=0.998001。字幕按本次要求替换，因此不声称全视频码流不变。



TT CTA 已匹配亚文化.xlsx / Tokyo-Tiger Hook库 / 行57，但现有模板窄安全区出现 copy_exceeds_safe_width，因此实际未显示；没有为显示文案而改变安全区、缩改文字或硬塞字幕。GC 没有可显示的 CTA，BRAND_COPY_NO_MATCH。两项均为明确可降级结果，不冒称 CTA 已在视频中显示。若要使 TT 这条较长 CTA 适配现有窄框，需要另行处理排版/候选适配，本轮不夹带该范围。

## 最小代码与统一策略

仅两运行时文件：
1. lib/classic-brand-activation.mjs：新增 normalOnly 判定；共用 verified_handoff、已校验绑定/来源一致性、正式文案和 BGM 配置检查。新业务开关 normalClassicBrandResources 和本机接收 cutoff normalEnabledAfter，仅对 GC/TT 生效；pagewings/NW 不因本次扩展而自动启用。正常任务一次返回 brandCopyEnabled=true、brandBgmEnabled=true 与 scope=normal_gc_tt 的相同身份标记。旧 Canary mode/state 不修改，正常任务不消耗或改写旧占位。
2. worker/batch-renderer.mjs：对正常业务身份按同一策略重新校验，同时启停文案/BGM；原 Canary 身份沿原判定。复用现有 Excel matcher、optional-copy、BGM-only、响度/循环与告警降级，保留源音轨移除和品牌隔离。音乐或排版失败仍允许安全出片，不能借模板/其他品牌伪装匹配。

还需在部署授权范围内修改 config/classic-brand-activation.json：normalClassicBrandResources=true，normalEnabledAfter=实际启用时刻。旧 enabled/mode/Canary 状态保留，不开全局 claims，不扩大接单。未识别/未配置品牌保留兼容路径和明确 no_bgm/告警，不谎称品牌资源匹配成功。

前轮音乐独立字段 bgmForVerifiedNewClassic/bgmEnabledAfter 未部署，本合并候选不依赖它们、不需要先装前轮补丁。独立技术 batch 开关仍保留，但 Classic 正常业务由同一个决策赋值。关闭 normalClassicBrandResources 即同时撤回新业务文案/音乐扩展，旧 Canary 不受影响。

## 验证

两个实际批次使用各自既有素材、EDL、缓存，未用旧 GC 样片替代；开启仅发生在隔离配置（cutoff 为覆盖这两个历史记录的 fixture 值，绝不能直接用于上线）。真正上线需使用授权启用时间，防止历史任务被纳入新范围。使用共享 Renderer 直接离线渲染，没有调用生产接收或执行器、没有重新做视觉分析，没有 Provider 调用，旧 MP4 未覆盖。

- 两片最终 Hook/CTA 抽帧目视核对；原片四帧也分别核对。
- 两片均在 8–18 秒内，单条品牌 AAC，响度/峰值通过，完整视频音频解码通过。
- 定向回归 35/35：copy、BGM、音频故障/循环、旧作用域、新正常 GC/TT 同时启用、未知/NW 拒绝、时间 cutoff、回滚关闭、旧占位不变、guided 和 v1 双源/v2 单/双/三/八源编码发布。
- 正常业务启用且旧 Canary 已被别的任务占用的 guided 共享渲染另 1/1，证明正常 Hook/音乐不再依赖旧占位。
- 无生产 Provider、配置、Quality Gate、Scheduler、8–18 秒规则、并发、接单或历史任务修改。新 helper 与测试 lint 无报错。没有声称全仓库测试或 Web build 通过。

## 实际生产与部署收口

当前生产根 D:/CUT-Releases/20261030-production-first-r11，Web BUILD_ID PRRG3CEDUkyKGmDEDCDlO。在线仍是旧单条 Canary，不具备正常 GC/TT 新任务自动匹配条件。本次候选未部署，生产作用域未变，根因尚未在生产消除。代码和两批次隔离证明已具备开启条件，不能用这句话冒充生产已生效。

patch/ 仅两模块，rollback/ 保存本次当前 r11 原件与原作用域配置，manifest.json 提供 before/after SHA256。开发同步保留其他已有改动，候选从真实生产底版构造，不能整目录覆盖开发源码进 release。

待授权部署范围：两文件 + 一个配置的正常业务开关与启用时间，一次安全重载实际依赖模块的空闲 Runner。部署前核对在线版本和 before/rollback hash、确认无活动租约；版本漂移或备份不符即停。成对安装，保持全局 claims/Provider/接单不变，由原 supervisor 重建；核对模块 hash、PID/心跳、健康及 old Canary 占位未变；复验本两批素材隔离片。然后仍需授权的新 GC/TT 业务任务验证新版本的实际 NAS 发布和经典回收，不能自动重跑本两条任务或擅自增加付费调用。

回滚触发：模块/配置不符、Worker 不健康、正常新任务仍出现文案/音乐范围错位、跨品牌或成片损坏。先关闭 normalClassicBrandResources（后续渲染同时撤回文案和音乐扩展），安全空闲窗口恢复 rollback/ 两模块及原配置并重载同范围 Runner，不删除任务、缓存、旧成片。旧占位保持，不开 all/global claims。恢复旧策略也会恢复本次旧 Canary 限制，不能宣称回滚可解决原普通任务无声。

状态：CODE READY（35+1 定向测试及两批真实素材隔离验证）；DEPLOY PENDING（两模块及统一配置启用）；DEPLOYED=false；VERIFIED=隔离验收，非生产新业务闭环。TT CTA 安全宽度省略和 GC CTA 无匹配均明确保留告警。
