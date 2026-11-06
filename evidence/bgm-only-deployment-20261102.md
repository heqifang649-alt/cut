# CUT BGM-only 受控生产部署（2026-11-02）

状态：CODE READY=true；DEPLOY PENDING=false；DEPLOYED=true；VERIFIED=已安装模块、Worker/服务健康及隔离渲染复验通过。新业务任务的生产发布/经典回收验收仍未执行，不能将隔离结果冒充该项通过。

## 部署版本与变更范围

- 用户本轮明确授权受控部署及必要 Worker 安全重载。当前生产根 D:/CUT-Releases/20261030-production-first-r11/，Web BUILD_ID jBLQ22K9cTC7micSQYXlC。
- 安装时间 2026-11-02T09:38:22.5849753Z（UTC，即北京时间 2026-11-02 17:38:22）。仅安装原已验收 patch/ 下两文件。没有复制开发目录中的其他脏改动。
- 业务音频版本 brand_bgm_only_v1；Renderer 策略签名 only-v1。代码不读取 source 音轨，无原音 amix；启用时仅品牌 BGM，不可用/未启用时视频-only，不回退原音/模板。

| 实际安装模块 | SHA256 |
|---|---|
| worker/brand-bgm.mjs | 53f7db94eb0a47d975773c91fd0af8603ef996c8276ab1add943717a1fce7631 |
| worker/batch-renderer.mjs | 654f4702827960898cb8b6aac08565fbf8223351958e0c69e5feac4ace142278 |

安装前两模块在线 before hash、补丁 after hash、rollback 备份 hash 全部匹配 manifest。Web build、两文件以外的品牌映射、Quality Gate、Scheduler、Provider、并发与时长规则未改。前后 18 项受保护文件 hash 一致，详见 preflight.json、live-verification.json、final-protection-check.json；包括品牌作用域配置/唯一 Canary 身份、Provider 配置、生产路径、历史记录、队列、模板/用户、QG policy、Scheduler、Web BUILD_ID。

## 安全重载与健康

安装前及重载前复查：无 running/leased 服务队列任务、无 queued/uploading/editing Classic 任务。原进程加载旧模块时没有热中断活动任务。只停止九个 Service Runner 和一个 Classic 多源 Runner，由现有未修改 supervisor 重建；Web、Fleet、Bridge、supervisor、计划任务均未重启/修改。

- data/classic-multisource-heartbeat.json: PID 41840；新进程、存活、心跳新鲜。
- data/service-heartbeats/analyze-analyze-1.json: PID 51572；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/analyze-analyze-2.json: PID 38940；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/analyze-analyze-3.json: PID 48960；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/clip-clip-1.json: PID 33560；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/clip-clip-2.json: PID 50232；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/clip-clip-3.json: PID 51484；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/render-render-1.json: PID 19356；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/render-render-2.json: PID 48644；新进程、存活、心跳新鲜，claimsEnabled=false。
- data/service-heartbeats/render-render-3.json: PID 40672；新进程、存活、心跳新鲜，claimsEnabled=false。

新 PID 均与重载前不同，创建时间晚于安装阶段；源脚本路径限定于当前 r11。模块 hash 和重载后 PID/心跳共同构成生产加载证据；另以独立进程直接导入在线文件复验，没有假称读取了 Node 内部模块内存。HTTP 首页 200；未登录 /api/health 401，认证边界保持正常。进程快照见 processes-before.json、processes-after.json，实际重载目标见 reloaded-processes.json。

## 安装模块隔离复验

1. 精确复用原 GC 选曲缓存，直接导入线上 worker/brand-bgm.mjs，重新生成 BGM-only WAV，复制原 GC 视频码流，仅重编音轨为独立 MP4。
   - 路径 installed-replay/GC-canary-BGM-only.mp4，10.5 秒，1 条 AAC 音轨。
   - 最终 AAC 实测 -16.01 LUFS、-5.37 dBTP；与对应 BGM 相关系数 0.9999063293067597，原音分量系数 -0.0001947275037169109。
   - 原/新视频码流 hash 相同，Hook、CTA、画面不变；原 MP4 hash 未变。
   - 输出 SHA256 a9c06fc318842f5f459b1159798960f906ed9c7bbe6de38ce710a061f2e30412。

2. 直接导入线上 worker/batch-renderer.mjs，复制现有 GC EDL 和 graded clips 到全新 E: 隔离目录，用同一 GC 品牌身份及既有 Hook/CTA 做完整共享 Renderer 渲染。没有调用任务接收接口或 executor，不运行分析、QG 或 Provider；validateLegacyProductConsistency=false 仅为隔离复验参数，没有改生产门槛。
   - 实际产物 E:\cutflow-bgm-only-20261102\deployment-20261102\full-renderer-replay\output\guidingcross.mp4
   - SHA256 48061c2664bc69415f1e8ca8fcba1d8567205d9050ad7dff4da2f6e5a9e33dbc
   - 10.5 秒，1080×1920，一条 AAC 音轨；完整视频+音频 -xerror 解码通过。
   - 最终 AAC 实测 -16.04 LUFS、-2.43 dBTP，符合目标约 -16 LUFS、峰值 <=-1 dBTP。
   - 对应品牌 BGM SaveClip.App_AQMuaqJ0w-4NNLPdr0iVZlT86gO-miOC09WhLM5PQQf5LN7i1X92AtSYuqsE9ujFyfkg2HrHJq22Z4y8Jtsuun7UaFbhEWxmIMegJkA.mp4，来源 \\192.168.120.60\新成片交付\批量剪辑素材\BGM\基督\SaveClip.App_AQMuaqJ0w-4NNLPdr0iVZlT86gO-miOC09WhLM5PQQf5LN7i1X92AtSYuqsE9ujFyfkg2HrHJq22Z4y8Jtsuun7UaFbhEWxmIMegJkA.mp4；BGM 参考相关系数 0.9989157423242686、原音分离系数 -0.00006041473491100663，符合无原音结果。
   - 完整 Renderer 新片视频码流与原片完全一致，hash SHA256=845b8029172790fc3dfb4d669a6c6c444d4d7d8ab648660cc2bf9ad7605dff64；Hook 为 Wear what you believe.，CTA 仍为空。导出元数据 source_audio=mute、mute_original_audio=true。

两个复验输出都在独立 E: 目录，不写入原 Canary 输出、NAS status 或经典回执，也未修改原素材。音频统计使用最终 AAC 测量的 input_i/input_tp，不混淆测量滤镜再次处理后的 output 字段。没有声称已进行新的生产业务任务或人工听审。

## 作用域、费用与后续

- 原品牌配置保持 enabled=true、mode=canary，仍锁定 d83ffadc-7664-482e-bec5-14b2230b788f 及原 manifest hash；没有改 all 或重置占位。
- 九个普通 Worker claimsEnabled=false。Classic 专用接单和现有执行范围保持原样。
- 原任务 attempt=1，既有 Provider used=6 未变。本轮新增 Provider 调用 0、生产任务提交 0；历史任务与成片未重跑/覆盖。
- 本次部署没有新代码在真实新 Classic 任务上的发布/回收证据。按用户要求止于部署和离线复验，下一步才验证一条新的 Classic 任务，不自动提交、执行或付费。

## 回滚

原 r11 两文件原始字节位于 ../rollback/，before hash 位于 ../manifest.json 与本目录 preflight.json。安装过程包含异常恢复分支，未触发回滚。未来若需要回滚，在无活动渲染/Classic 租约的维护窗口成对恢复两文件并安全重载相同范围 Worker，核对 before hash；不删历史任务、缓存、输出或回执。恢复旧代码将恢复旧音频行为，应按已确认的维护回滚边界操作；若仅需临时安全禁音，可保持新 Renderer 并关闭独立品牌启用开关，后续成片视频-only。禁止改全局 claims 来实施回滚。
