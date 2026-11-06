# GC/TT 品牌文案+BGM 统一启用生产部署（2026-11-03）

DEPLOYED=true。VERIFIED=生产模块加载、Worker/服务健康、作用域判定及已安装模块隔离 TT/GC 渲染通过。新 GC/TT 自然业务任务的 NAS 发布和经典版 PENDING_REVIEW 验收尚未进行：截至 final-check.json 时间未自然接入新合格任务。不得把此项标为生产业务闭环已通过。

## 实际版本与范围

生产根 D:/CUT-Releases/20261030-production-first-r11，Web BUILD_ID PRRG3CEDUkyKGmDEDCDlO。用户本轮明确授权安装“两个模块＋统一启用配置”，未安装前一轮独立 BGM-only 启用方案，也未混入工作区其他改动。

| 实际生产模块 | SHA256 |
|---|---|
| lib/classic-brand-activation.mjs | e0562236f15bf0a61bcf0a857c83a8bc77887571daf96518e7663f3ea797c90f |
| worker/batch-renderer.mjs | 29c5369c32019322f599da1e65372e5911231c20921921ff2d98b4e8b80c1e83 |

安装时间 2026-11-03T08:47:04.9336662Z（UTC）；模块文件、已验收 patch/ 和 rollback/ 的前后 hash 在 preflight 阶段逐一相符。当前 BGM-only、8–18 秒时长补丁继续保留。旧 Canary 状态、品牌映射、QG、Scheduler、Provider、并发、用户/模板/队列等 17 项受保护 hash 均未变；所有部署前历史 Classic 记录内容相同。

## 统一正常业务配置

实际启用时刻 2026-11-03T08:48:25.539Z，即北京时间 2026-11-03 16:48:25.539。以 CUT 本机 acceptedAt（旧 guided 使用 receipt.createdAt）严格晚于该界限判定，不信任上游自报日期，不把既有任务自动迁入。

新增 normalClassicBrandResources=true、normalEnabledAfter=2026-11-03T08:48:25.539Z。GC/TT 正常新任务在同一共享判定下同时获得 brandCopyEnabled=true、brandBgmEnabled=true；未新增文案/音乐不一致的独立正常业务开关。既有技术 batch 开关保留，scope=normal_gc_tt 的任务在渲染入口同时重新校验。

旧 enabled=true、mode=canary、enabledAfter 和唯一旧任务占位原样保留；正常 GC/TT 分支在旧占位前判定，不再被它排除。仅明确、已校验且正式配置的 guidingcross/tokyotiger 生效；NW/pagewings 不在新扩展内，不做身份猜测。普通 claims 不变，九个 Service Runner 仍 claimsEnabled=false；接单/任务执行范围不扩大。

只读 predicate fixture 检查证明：cutoff 后 GC/TT 允许、之前拒绝，NW/pagewings 均不获新范围。这些是契约探针，不是提交或伪造真实上游任务，见 scope-probe.json。

## 安全重载与健康

安装和重载前都确认无 running/leased 服务任务、无 queued/uploading/editing Classic 任务。仅重载九个 Service Runner、Classic 多源 Runner 和 Bridge Runner 共11个，由既有未改 supervisor 重建；无活动任务被中断，未重启 Web、Fleet 或 supervisor。

重载后11个 Worker 均为新 PID、实际存活、心跳新鲜；PID与安装前不同。Worker 脚本在当前 r11，新进程时间和文件 SHA 构成加载证据；没有虚构读取进程内部模块缓存。PID/心跳见 live-verification.json，完整进程快照见 processes-before/after.json。HTTP 首页200，未认证 /api/health 401；原认证边界正常。

## 已安装生产模块隔离复验

直接从 r11 文件 URL 导入两个已安装模块，用这两个真实任务各自的原素材、EDL 和 graded clips 到全新 E: 隔离目录完整渲染；未调用生产任务接收/执行器、没有重新分析或调用 Provider，未覆盖旧片或写回 NAS status/经典回执。隔离 policy 为覆盖历史记录而使用已明确标记的回放 cutoff，未写入生产；实际生产 cutoff 如上。

### TT / 4a4e8f83-2c9a-48cc-b310-60cbe902a3b0

- 关联 CUT batchId 4c2b00a3-cae6-479a-9398-41c419db3d7a，独立输出 E:\cutflow-brand-combined-20261103\deployment-20261103\installed-replay\4a4e8f83-2c9a-48cc-b310-60cbe902a3b0\output\tokyotiger.mp4；SHA256 54104ab8c509e328a72d1b5c9b6b57cbd770f82dfdbc98cc4931686cc8838514。
- 14.040000 秒，一条 AAC，品牌 BGM TT260811GA01.mp4；NAS 曲目来源 \\192.168.120.60\新成片交付\批量剪辑素材\BGM\亚文化\TT260811GA01.mp4。
- 最终 AAC -16.03 LUFS、-5.89 dBTP；与实际归一化品牌音乐相关系数 0.9998330822018965；originalAudio=false，完整视频+音频解码通过。
- 实际 Hook WEAR WHAT YOU’RE INTO；Excel 来源 亚文化.xlsx/Tokyo-Tiger Hook库/行4/hash 5df70996a1db266cbacacc5342ad34290bf49edc3872b3c73ccc9e8cd32b7972。
- CTA 选择 CHECK IT OUT AT TOKYO-TIGER，来源 亚文化.xlsx/Tokyo-Tiger Hook库/行57；实际显示 省略；layoutWarnings=[{"kind":"cta","reason":"copy_exceeds_safe_width"}]，无额外匹配告警。

### GC / 10d743b1-fd2e-46a4-bcdd-2d3532fdafd8

- 关联 CUT batchId 55916ccf-b246-42fb-a680-99d4852f9275，独立输出 E:\cutflow-brand-combined-20261103\deployment-20261103\installed-replay\10d743b1-fd2e-46a4-bcdd-2d3532fdafd8\output\guidingcross.mp4；SHA256 f78863f5597c85d689d54773c5772a34d9bd5863aaf975aa27aba3e15c46ffe9。
- 14.040000 秒，一条 AAC，品牌 BGM TikSave.io_7385525741682806048.mp4；NAS 曲目来源 \\192.168.120.60\新成片交付\批量剪辑素材\BGM\基督\TikSave.io_7385525741682806048.mp4。
- 最终 AAC -16.02 LUFS、-4.92 dBTP；与实际归一化品牌音乐相关系数 0.9998747816128528；originalAudio=false，完整视频+音频解码通过。
- 实际 Hook Wear what you believe.；Excel 来源 基督.xlsx/GC Hook总库/行11/hash cfae0b39ee869c18ec3630c1d2088c1d068615a988b67b171af81bb01b587792。
- CTA 选择 空，来源 无匹配；实际显示 省略；layoutWarnings=[{"kind":"cta","reason":"empty_copy"}]，BRAND_COPY_NO_MATCH。


文案与音乐来自各自品牌，不使用旧模板文字/音乐。TT CTA 选择成功但窄安全排版放不下，允许省略并告警；GC 无匹配CTA同样省略告警。没有改安全区、强制塞入文字或把选择记录当作实际显示。输出复用原商品素材与剪辑结构，只有文案替换和品牌音频接入，时长都在8–18秒内。没有原始音轨参与；BGM长度/循环/响度继续用既有已验收模块。

## 新真实业务任务

截至 2026-11-03T08:52:21.148Z，启用后新接入的合格 GC/TT 任务数为 0。natural-tasks.json 与 final-check.json 保存查询结果。本次没有主动提交新任务或启动付费测试，也未重跑两个历史无声任务；既有 Provider 用量没有被隔离复验增加。等待下一条自然业务任务，后续还需核验实际 Hook/CTA/BGM、AAC、完整解码、NAS hash/status 与经典版 PENDING_REVIEW 回执，不能由本隔离复验代替。

## 回滚位置与步骤

两模块旧 r11 原件在 ../rollback/lib/classic-brand-activation.mjs、../rollback/worker/batch-renderer.mjs；原配置在 ../rollback/classic-brand-activation.json，恢复目标是 r11/config/classic-brand-activation.json。../manifest.json、preflight.json 保存原件及补丁 hash。

紧急撤回正常业务扩展：原子设置 normalClassicBrandResources=false，保留旧 Canary 字段与占位；后续正常 scope 文案/BGM同步撤回，不清理任务和成片、不改 claims。完整文件回滚需在无活动租约的安全窗口，成对恢复两模块和原配置、核对 before hash，安全重载相同11个 Runner；原素材、缓存、NAS回执和历史任务原样保留。发生模块/配置漂移、错品牌、Worker异常或回归即按授权回滚，本次未触发。

状态：CODE READY=true；DEPLOY PENDING=false；DEPLOYED=true；VERIFIED=模块/健康/作用域/隔离复验通过，真实新业务验收等待。
