# CUT 批次级品牌启用与单条 Canary（2026-11-02）

结果：最小代码已部署至 r11；已完成一条 GC 新任务的真实 Quality Gate→Scheduler→Renderer→NAS→经典版回执验证。技术验收通过，CTA 缺库按规则省略并告警。Provider 实际美元账单未返回、经典版浏览器 UI 未独立复核；不宣称全生产闭环或全品牌放量通过。按最新单条授权保持 canary 模式，不自动继续其他品牌任务、不自动晋级 all。

## 实际生产状态

- release：D:/CUT-Releases/20261030-production-first-r11；Web BUILD_ID jBLQ22K9cTC7micSQYXlC。
- 2026-11-02 14:54 安装；安装前无 running/leased 服务任务及 queued/uploading/editing Classic 任务。仅重载九个普通 service-runner、bridge 与 multisource 共 11 个 Runner，由原 supervisor 重建。未重启 Web/Fleet/supervisor、未修改计划任务。
- 14:57:43（Asia/Shanghai）按授权开启独立作用域配置；enabled=true、mode=canary、enabledAfter=2026-11-02T06:57:43.671Z。全局品牌环境开关没有开启，普通 Worker claimsEnabled 九项仍 false；现有专用 Classic 接单范围不变。
- 独立状态锁定唯一任务 d83ffadc-7664-482e-bec5-14b2230b788f 及其 manifest hash。不会自动改选或晋级。部署前后 15 项受保护文件哈希不变；真实 Canary 后仅 classic-multisource-records 随该新任务正常更新，其余 14 项不变，详见 post-canary-runtime.json。

## 修改文件

- lib/classic-brand-activation.mjs（新增）：共用判定、本机接收时间 cutoff、verified_handoff、正式文案/音乐映射、来源一致性与 per-product 跨品牌防护；首次 canary 原子占位，task/hash/接收时间绑定，失败/重启不自动换下一条；异常仅警告并回退；all 需显式验收配置。
- lib/libtv-bridge.mjs：原单源与旧 guided 两处构造 batch 后调用共享判定，接收时间使用 receipt.createdAt，沿用经验证的 manifest 品牌。
- worker/classic-multisource-executor.mjs：校验并加载 record 后调用共享判定，使用 acceptedAt，在任何正常质量调用前锁定唯一 scope；渲染 batch 传递两项启用字段及作用域证据。
- worker/brand-bgm.mjs:11：增加 batch.brandBgmEnabled，保留原全局接口兼容；没有开启全局环境变量。
- worker/batch-renderer.mjs：传 batch 给 BGM 开关；已标记 scoped 的任务在渲染入口复核独立 policy，关闭后即使 batch 已保存启用字段仍可回退。其余渲染与现有 internal-cut repair 原样保留。
- config/classic-brand-activation.json（新增）：独立启用/回滚配置；patch/ 默认 disabled。线上启用事件另存 deployment/activation-event.json。

完整前后文件 SHA256：deployment/manifest.json。四个原 r11 被修改文件原始字节：deployment/before/。新增 helper/config 单独记录。独立补丁：patch/。开发侧同步只添加同一接线，未覆盖先前工作区 Scheduler/short-shot 改动。

TT=tokyotiger、GC=guidingcross，NW 只识别正式映射明确 NW；pagewings 不识别。未改接单/claims、Quality Gate、Scheduler、Provider、并发或时长规则。未知品牌/历史接收/未开启任务不设置新启用字段，保留兼容路径。资源选择复用已安装的品牌模块，缺资源省略、同品牌缓存/原音/静音降级，不借模板或其他品牌。

## 验证结果与限制

- scope 单元测试 7/7；开发树同步后再验 7/7，见 development-scope-tests.txt。
- 最终 targeted：63/64。唯一失败为既有 guided one-shot failure 测试，预期 failed 而实际 batch_queued；将 runner 改为未修改 r11 基线，仍同样失败，详见 guided-baseline.txt。没有改 claims 或生产规则去消除该失败；新增 guided 品牌批次开关测试通过。
- 原有 executor v1 两源、v2 单/双/三/八源 5/5 真编码/发布回归通过。
- 三品牌单/双源 scoped matrix 最终 6/6；全局两项品牌开关关闭，只靠独立作用域自动启用；安装后的 r11 模块再验 6/6。核验编码、NAS fixture 发布、>=8 秒和完整解码。
- 同一真实 GC 素材/EDL 的三品牌双输出共六条机制测试及缺文案/音乐降级 MP4 通过，音轨与所选曲目相关性 >0.95；复用已有成片哈希不变。此组 TT/NW 同 GC 画面仅用于品牌资源机制，不当作 TT/NW 商品交付。
- lint 0 errors；两个 Renderer 既有 no-unused-expressions warning 和 candidate 缺 pages 提示，不为消除提示修改渲染代码。本补丁是运行时模块，没有重建 Web，没有用 Web build 冒充运行时验证。
- Classic 单源、双源 scope 渲染贯通；guided 经真实 bridge fixture 导入、持久化开关及后续既有回归通过，没有本轮新的 guided 上游真实付费成片验收。NW 无真实入口样本，仅显式身份隔离测试。未知品牌保持兼容已有测试覆盖。

## 本条真实 Canary

- Task ID：d83ffadc-7664-482e-bec5-14b2230b788f
- Batch ID：8e320510-c4c1-4f7f-8348-82df15a64a57
- manifest SHA256：f700133c914c1803a14ccfc39c4655f0ed7792cca408df4de28e29af87f9dcbc
- 本机接收：2026-11-02 14:59:03，晚于启用 cutoff；guidingcross 绑定，两源 brandIdentity 均一致，尝试次数 1，未手动重提或重跑。
- Quality Gate：两源 READY，6 份完整 Provider evidence；Scheduler/Renderer 实际结果 10.5 秒，符合本次 8–18 秒验收区间。没有更改规则去匹配时长。
- Hook：Wear what you believe.；基督.xlsx / GC Hook总库 / 第 11 行；工作簿 SHA256 cfae0b39ee869c18ec3630c1d2088c1d068615a988b67b171af81bb01b587792。成片抽帧目视核对一致。
- CTA：当前无可用 GC 文案，source=none、warning=BRAND_COPY_NO_MATCH；实际结尾无 CTA，未借用其他品牌，未阻塞成片。
- BGM：TikSave.io_7385525741682806048.mp4，NAS BGM/基督，selected；保留原音、已有 BGM gain=0.08。源路径 sidecar 与品牌目录核对通过；发布 MP4 音轨与送入编码器的混音 WAV 相关系数 0.999921196671514。未做逐首主观听审。
- 成片 outputId：af8effdd-b227-4222-9d7a-b7027160235f；大小 11937987 bytes，1080×1920；实际 10.5 秒。NAS 文件 SHA256、CUT/NAS status、classic 回执 hash/size/ID 均一致。
- SHA256：e46de2d4e01f638be54b8b39d94cd96108fc8109cd4b971393268f902da4f015
- NAS 原文件已全量 FFmpeg -xerror 视频与音频解码通过，非仅检查文件存在。NAS relativePath：outbox/d83ffadc-7664-482e-bec5-14b2230b788f/af8effdd-b227-4222-9d7a-b7027160235f.mp4。
- 经典版真实写入 yiying-classic-import/1 回执，writer=classic，PENDING_REVIEW / PENDING，回收时间 15:03:45；taskId/batchId/manifest/output hash 对齐。注意回执 appEnv=development、buildId=unconfigured，不能据此宣称经典版生产前端版本已核验；浏览器 UI 未独立操作。
- Provider：gpt-6-sol，responses；6 次 dispatch、6 份成功证据，既有上限 20 未变。输入 251183 tokens，输出 1621 tokens，总计 252804 tokens。正常首次任务 attempt=1，没有自动更换下条 Canary。
- 实际货币费用：未能核实。现有 telemetry 只有 tokens，没有计费金额/账单；不能将 policyReceipt 的 settled_upstream_no_additional_charge 当作本次 API 免费或实际费用。尚缺 Provider 账单核对，此项明确未验证。

原始结构证据及完整 telemetry、NAS/经典回执：deployment/CANARY.json、canary-nas-status.json、canary-classic-receipt.json。验证脚本 verify-live-canary.mjs 只读任务与媒体，仅向证据根写入结果/抽帧，没有触发 Provider 或重跑任务。

## 回滚与后续状态

执行 deployment/DISABLE-SCOPED-BRANDS.ps1 即关闭独立资源作用域；不改 claims/接单、不中断已开始渲染、不删除成片。完整文件级回滚条件及原 r11 备份见 deployment/ROLLBACK.md。

当前保持单条 canary 已占位，不改成 all。尚未验证的费用账单、经典版浏览器 UI、TT/NW 生产入口不虚称完成；没有自动执行第二条任务。未来扩大范围应明确确认验收范围与费用证据，不能把隔离矩阵等同所有入口生产闭环。
