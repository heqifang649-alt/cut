# 两个真实 Classic 无声任务专项修复（2026-11-03）

结论：两个任务分别核验，根因相同且均有各自真实证据。已准备最小代码修复和各自独立 MP4，未部署，未扩大生产品牌作用域。用户给出的两个“Batch”标识实际匹配 Classic taskId；关联 CUT batchId 如下。

| 项 | 用户标识/Classic Task | CUT batchId | 品牌 | Canary | 原音轨数 | 修复 LUFS | 修复 dBTP |
|---|---|---|---|---|---:|---:|---:|
| A | 4a4e8f83-2c9a-48cc-b310-60cbe902a3b0 | 4c2b00a3-cae6-479a-9398-41c419db3d7a | TT | 未命中 | 0 | -16.05 | -4.30 |
| B | 10d743b1-fd2e-46a4-bcdd-2d3532fdafd8 | 55916ccf-b246-42fb-a680-99d4852f9275 | GC | 未命中 | 0 | -16.04 | -2.61 |

## 实际根因

生产现为 r11，服务 Web BUILD_ID PRRG3CEDUkyKGmDEDCDlO（11月3日另一次时长部署后的实际版本，不能使用昨天旧 BUILD_ID）。本次不回滚或覆盖该时长部署。

独立品牌配置仍 enabled=true、mode=canary，状态只锁定旧任务 d83ffadc-7664-482e-bec5-14b2230b788f。A、B 的品牌都明确、已校验，但与唯一 Canary 身份不同，enableClassicBrandResources 返回空对象，未设置 brandBgmEnabled。BGM-only Renderer 对所有最终输出排除原音/模板，而 prepareBrandAudio(enabled=false) 返回无音乐；最终 FFmpeg 使用 -an。两个成片都确实没有音轨，不是低音量、NAS 串片或跨品牌问题。

此前将“保持单条音乐作用域”与“全输出原音移除”组合后，会使范围外的合法品牌任务无声。这是已由本次两条真实任务验证的兼容缺口，不是待验证猜测。修复需要对已校验新任务单独授权品牌音乐，不能仅靠调高音量或重复重启解决。

### 4a4e8f83-2c9a-48cc-b310-60cbe902a3b0

原文件：95a805f07902da6ed9c028cb07a727bce54c96d4388df31ec8fdb9f5485f5f41；CUT 本地输出与 NAS 哈希一致。输出仅 H264 视频流，无 AAC/其他音轨，响度不存在，不能当作 0 LUFS。原 checkpoint 的 BGM 状态为 no_bgm、originalAudio=false，警告 BGM_DISABLED_NO_SOURCE_FALLBACK；没有选曲、没有 FFmpeg 音频编码，而是执行了最终 -an 路径。

sourceBinding=tokyotiger，所有来源 brandIdentity 同绑定。原渲染 BGM 决策已识别 TT；结合 outputBrand 仅接受可信 provenance 的实现，说明品牌上下文已到 Renderer，并非识别失败。原临时 batch 对象未单独保存，不虚构其 JSON 快照；离线按生产 executor 的 trusted context 转换重建，其值见 two-batch-verification.json。原 taskId、关联 CUT batchId、manifest、接收时间、checkpoint、输出文件路径分别保存在 4a4e8f83-2c9a-48cc-b310-60cbe902a3b0.json。

修复离线片 E:/cutflow-two-silent-20261103/4a4e8f83-2c9a-48cc-b310-60cbe902a3b0/fixed.mp4；SHA256 fc9b910405af1d14498b9feb438a0f980965cc6f75303519e29e19eddbb76b8c。音乐来源 \\192.168.120.60\新成片交付\批量剪辑素材\BGM\亚文化\TT260824AA02.mp4；最终音轨和选定归一化音乐相关系数 0.9996632677818315；只有 1 条 AAC，14.033333 秒，完整解码通过；没有读入原始素材音轨。复制原视频编码流，所以画面/Hook/CTA/时间线完全相同；原 NAS 成片 hash 保持不变。

### 10d743b1-fd2e-46a4-bcdd-2d3532fdafd8

原文件：097e19f66789b353cc6a2253b6d107a726ae0bb393a637b828223cf001f9cd5a；CUT 本地输出与 NAS 哈希一致。输出仅 H264 视频流，无 AAC/其他音轨，响度不存在，不能当作 0 LUFS。原 checkpoint 的 BGM 状态为 no_bgm、originalAudio=false，警告 BGM_DISABLED_NO_SOURCE_FALLBACK；没有选曲、没有 FFmpeg 音频编码，而是执行了最终 -an 路径。

sourceBinding=guidingcross，所有来源 brandIdentity 同绑定。原渲染 BGM 决策已识别 GC；结合 outputBrand 仅接受可信 provenance 的实现，说明品牌上下文已到 Renderer，并非识别失败。原临时 batch 对象未单独保存，不虚构其 JSON 快照；离线按生产 executor 的 trusted context 转换重建，其值见 two-batch-verification.json。原 taskId、关联 CUT batchId、manifest、接收时间、checkpoint、输出文件路径分别保存在 10d743b1-fd2e-46a4-bcdd-2d3532fdafd8.json。

修复离线片 E:/cutflow-two-silent-20261103/10d743b1-fd2e-46a4-bcdd-2d3532fdafd8/fixed.mp4；SHA256 19bff1defae599ad53a24124cf7f043052ef9a2d2ec55099669291c3c25fbe3e。音乐来源 \\192.168.120.60\新成片交付\批量剪辑素材\BGM\基督\TikSave.io_7580829262563790111.mp4；最终音轨和选定归一化音乐相关系数 0.9997258961335409；只有 1 条 AAC，14.033333 秒，完整解码通过；没有读入原始素材音轨。复制原视频编码流，所以画面/Hook/CTA/时间线完全相同；原 NAS 成片 hash 保持不变。


## 最小修复及边界

代码仅两文件：
- lib/classic-brand-activation.mjs：复用现有同一个合法品牌/正式配置/来源一致性判断，新增 musicOnly 判定及独立策略 bgmForVerifiedNewClassic、bgmEnabledAfter。默认未配置即不扩大；独立 cutoff 排除旧接收记录，不改原 copy Canary 的 enabledAfter、mode 或唯一状态。新的音乐授权只写 brandBgmEnabled/classicBrandBgmActivation，不打开 brandCopyEnabled、不领取/创建任务。
- worker/batch-renderer.mjs：渲染入口重新校验上述独立音乐授权；原 Hook/CTA 的 Canary 判定原样保留。关闭音乐独立开关即停止后续范围外选曲。音乐处理继续使用现有 BGM-only 归一化/同曲循环、同品牌重选和 no_bgm+明确 warnings 降级，不回退原音或模板。视频成功与配乐成功分开记录，不将 no_bgm 标成 selected。

生产真正生效还需修改一个独立配置文件 config/classic-brand-activation.json：新增 bgmForVerifiedNewClassic=true，以及实际授权启用时刻 bgmEnabledAfter。此举是明确扩大“新合法品牌任务音乐”的范围，必须由用户授权；本轮仅在隔离目录开启。不会扩大文案 Canary、全局 claims 或 Worker 接单范围。品牌未知/未配置不猜品牌，尤其不将 pagewings 映射 NW；若希望未知品牌任务也必有音乐，需要额外业务身份输入，本补丁不能安全猜测。

## 测试与复现

- 两个真实任务各自在隔离目录使用原 policy/canary 状态复现：新任务不命中，启用字段为空；各自原 NAS MP4 的无音轨及 warning 也已现场读取确认。
- 只在隔离配置开启独立音乐后，两条均得到 BGM=true、copy 未启用，完成各自实际音乐 AAC 编码、内容相关性、响度、视频码流保持及解码验证。没有用旧 GC 样片替代。
- 作用域、BGM、音频故障/长度、guided 音频及 Classic v1 双源、v2 单/双/三/八源相关回归共 24/24；新增独立音乐 + 原 copy Canary 未命中的 guided 共享渲染场景另 1/1。见 regression.txt、independent-music-test.txt。
- 新作用域测试明确覆盖原 Canary 状态不变、copy 不开启、独立开关关闭、cutoff 前任务、pagewings 拒绝。复用已有正式品牌映射，不改 Scheduler/QG/Provider/8–18 秒规则。
- 本次没有重新分析或调用视觉 Provider；未调用生产任务执行器/接收接口，没有覆盖历史输出和 NAS 回执。manifest.json 保存线上 before 和补丁 after；rollback/ 保存当前 r11 原文件。候选基于最新生产源码，开发同步只增加同一代码及测试，不将其他工作区改动混入补丁。

## 部署及回滚方案（待授权，未执行）

1. 安装范围：patch/ 两模块，加上独立配置的音乐开关/实际启用 cutoff；文案 Canary mode/state 保持原样。部署前再次核对最新 r11 模块 before hash、当前 BUILD_ID 和回滚原件，若版本漂移先停止。
2. 无活动任务/租约的维护窗口成对安装，安全重载实际使用模块的空闲 Runner，由原 supervisor 重建；不重启 Web、不改 claims/接单、并发和 Provider，不动持久化数据。
3. 核验哈希、心跳/健康、作用域状态未变，再用这两个批次的素材隔离复验；不重新执行这两个历史 task，也不写回旧输出。生产随后仍需一条经授权的新业务任务验证选曲、真实 NAS 发布与经典回收。
4. 回滚触发：哈希或备份不符、健康/模块加载失败、错误品牌、预期应配乐的新任务异常无声、音频/视频回归。先关 bgmForVerifiedNewClassic 以停止扩展，再于安全空闲窗口恢复 rollback/ 两模块及保存的原配置，安全重载同范围 Worker；保留所有历史数据和文件。注意恢复原配置会回到原单条 Canary 限制，不能声称其会修复本次普通任务无声。

状态：CODE READY（定向回归 24+1 通过、两个真实任务隔离修复验证通过）；DEPLOY PENDING（两文件代码及独立音乐配置启用）；DEPLOYED=false；VERIFIED=仅隔离，不是生产验收。实际生产仍保留本次已确认的无声路径，未授权前不擅自开启新范围。未来新任务仍需验证。
