# CUT 品牌 Hook / CTA / BGM 隔离验收（2026-11-02，本轮）

结论：**品牌资源后端最小闭环已通过隔离验证，可作为仅处理明确品牌的新任务的受控试运行候选；未部署、未重启、未启用生产开关。不能宣称全品牌真实上游业务已经全部验收。**

本轮以重新扫描的实际 NAS 文件为准。用户已明确 GC 没有 CTA，正常省略；用户已将九格前端查找移出本轮范围，九格全部标记“未验证”，不作为当前隔离验证的阻塞。

## 最新资源

| 品牌 | Excel | 有效 Hook | 有效 CTA | BGM 目录 | 音乐候选 | 音轨探测及首秒解码通过 |
|---|---|---:|---:|---|---:|---:|
| GC | 基督.xlsx | 37 | 0（预期省略） | BGM/基督 | 23 | 23 |
| TT | 亚文化.xlsx | 55 | 11 | BGM/亚文化 | 12 | 12 |
| NW | 暗黑.xlsx | 55 | 55 | BGM/暗黑 | 279 | 279 |

根目录：`\\192.168.120.60\新成片交付\批量剪辑素材`，文案目录 `HOOK文案`，音乐目录 `BGM`。文件不需重命名或搬动，没有增加后台。

三份 Excel SHA256 分别为：

- GC：`cfae0b39ee869c18ec3630c1d2088c1d068615a988b67b171af81bb01b587792`，9930 字节。
- TT：`5df70996a1db266cbacacc5342ad34290bf49edc3872b3c73ccc9e8cd32b7972`，13876 字节。
- NW：`8ae4fd5adc75a92e41716f117d1ee3be671863d911ac67961772cffb0a75ce98`，18577 字节。

Excel 文件与上轮相同是本轮直接读取后的事实；GC CTA=0 也已得到用户确认，不能当成待补库故障。GC/TT 音乐已补齐，不再使用上轮空库结论。音乐逐文件路径、大小、mtime、时长和音频格式保存在 inventory/inventory.json，并给出每品牌 inventoryHash。314 首全部进行了音轨 probe 和首秒真实解码；这不是全库完整解码或逐首听审。被选入 MP4 的音频另外完成了最终产物验证。

## 品牌是否真正来自上游

只读核查现有 NAS manifest，未提交或重跑任何历史任务。`upstream-manifests.json` 保存每个样本的路径、品牌字段、源数、manifest SHA256 及接收记录哈希匹配结果。

| 路径 | 真实上游观察 | 本轮隔离验证 |
|---|---|---|
| Classic v2 单源 TT | 已发现 sourceBinding.kind=brand、value=tokyotiger，sources[].brandIdentity 相同，哈希与接收记录匹配 | 验证后的 record→Executor→Renderer→文案/BGM 均为 TT；真实 FFmpeg 编码及隔离发布通过 |
| Classic 多源 TT | 已发现明确 tokyotiger 品牌及一致源品牌，哈希匹配 | 同上，多源流程通过 |
| Classic 多源 GC | 已发现明确 guidingcross 品牌及一致源品牌，哈希匹配 | 同上，规范化为 GC，通过 |
| Classic 单源 GC | 当前接收样本中未发现 | 用显式 GC manifest 的新隔离样本通过；不是声称观察到了真实上游单源 GC |
| Classic 单/多源 NW | 当前接收样本中未发现 NW | 两条新隔离 manifest 明确携带 NW，接收校验、Executor、Renderer、实际品牌音乐均通过；仍不是 NW 真实上游已验证 |
| 旧 LAN guided | 可读取的旧真实样本未携带 source.brand_id / brand_copy | 新隔离请求分别携带 guidingcross、tokyotiger、NW，hash 验证后均保留 verified_handoff 品牌；不带品牌的样本保持无品牌，不推断为 GC |
| 九格前端 | 按用户最新指示暂不查找 | 未验证；未新增前端功能 |

没有用 `site_id`、模板、素材文件名或画面猜测品牌。实际来源是上游明确的 `sourceBinding.value`（单/多源）或者 manifest 的 `source.brand_id` / `brand_copy.brandId`（旧 bridge）。没有品牌时继续安全剪辑，但不能宣称已做品牌匹配。

## 最小候选与生产保护

候选位置：`E:\cutflow-brand-final-20261102\candidate`。以当前生产 r11 的 lib/worker 原文件建立隔离副本，只包含四个品牌模块差异，逐文件 SHA256 在 candidate-manifest.json：

1. lib/brand-copy-library.mjs：统一规范化 NW。
2. lib/brand-copy-match.mjs：无支持文案时省略并告警，禁止模板文案补位。
3. lib/libtv-bridge.mjs：guided 也保留已验证的上游品牌。
4. worker/classic-multisource-executor.mjs：从已验证品牌绑定建立 renderer 的品牌上下文，未知绑定不能继承模板品牌。

复用了既有动态 Excel 加载、每批冻结快照、last-good 文案缓存、按品牌及目录映射分区的 BGM 本地缓存。每条 Output 分别匹配文案、选曲并保存来源；不要求每次文案都不同。本轮各品牌两条连续 Output 的音乐均不同；多进程同时随机选择仍可能重复，属于 best-effort 去重，无新增全局等待锁。

生产底版的 batch-renderer、brand-bgm、Quality Gate、Scheduler 等保持逐文件相同。工作区原有 short-shot/调度修改没有带入候选。没有写入生产 release，没有改生产配置/并发/Provider，没有修改历史 Batch 或复制覆盖持久化 data/storage。

在生产源码候选上完成了额外复核：初次测试缺少该底版要求的历史任务隔离策略文件，随后复制原策略到隔离候选并在候选工作目录执行，6/6 通过。策略内容没有修改，也没有放开历史任务。

## MP4 实测

主要证据目录：`E:\cutflow-brand-final-20261102`。

### 各品牌自身素材样例

| 品牌 | 视频素材 | Hook 原文 | CTA 原文 | 实选 BGM | MP4 时长 |
|---|---|---|---|---|---:|
| GC | 原已验证 GC 计划的同一商品视频 | Christian clothing doesn't have to be boring. | 省略 | 基督/TikSave.io_7385525741682806048.mp4 | 12.033333 秒 |
| TT | 原 TT4-M1 同一商品计划 | EASY TO WEAR. HARD NOT TO NOTICE. | FIND YOUR NEXT EVERYDAY FAVORITE | 亚文化/TT260811GA01.mp4 | 9.6 秒 |
| NW | 暗黑/121 的 3108、3113 两个原视频，各取 5 秒，1.00× | YOUR CLOSET NEEDED SOMETHING WEIRDER | Finally, something different. | 暗黑/BGM/261012/7647175100831223054.mp4 | 10 秒 |

以上使用生产 Renderer 的隔离副本，完整解码均通过；Hook/CTA 抽帧已目视核对，原文字词及标点保留。文案记录包含品牌、entryId、工作簿 SHA256、sheet 和 row。音乐 sidecar 记录实际 NAS 源路径，未使用 template-bgm.m4a。每条产物哈希、源视频哈希及输出路径见 brand-source-examples/report.json。

NW 两源来自同一 121 商品目录，开场帧与该目录原始“正面1.webp”对照，均为橙黑色 LONG LIVE HALLOWEEN 猫/南瓜/骷髅图案球衣。没有通过减速或循环视频凑够 8 秒。这里只对照了受控样例的画面，不冒充新生产 Quality Gate 完整验收；原 Quality Gate 实现没有变更。

实际 MP4 解码音轨与送入编码器的真实混音 WAV 的相关系数：GC 0.99986、TT 0.99993、NW 0.99987。TT 原音保留，BGM 采用已有 0.08 增益；无原音时采用 0.5 增益。见 brand-source-audio-check.json。

### 同一输入的隔离对照及连续出片

release-renders/report.json 为相同真实 GC 视频输入、相同 EDL 的三个品牌对照，每品牌两条 Output，共六条 12.04 秒 MP4。该组专门验证资源机制，TT/NW 的该组画面不作为品牌商品交付；上表另给各品牌自身素材样例。

- 六条 Hook/CTA 实际排版文本均与对应库原文逐字相等，GC CTA 为空。
- 每品牌两条 BGM 不重复，所有选择源均落在对应品牌 NAS 目录。
- 六条完整解码通过，音轨与所选品牌曲的相关系数为 0.971–0.997（选择有能量窗口并补偿编解码延迟）。部分曲目有前置静音，测试已按实际有效窗口检查，没有为了通过修改音频实现。
- 实测无原音时增益约 0.496–0.500；最后 0.1 秒相对未淡出曲目的归一化能量幅度比约 0.072–0.092，确认已有 0.8 秒自然淡出生效。
- 再次执行渲染时，已完成 MP4 的哈希保持一致，没有为了随机音乐重写已完成输出。
- 另做资源故障实渲染：空文案快照、不可用音乐映射，同时提供模板音乐，仍成功产出至少 8 秒、完整可解码 MP4；文案省略、保留原音或静音并明确告警，没有借用模板音乐或其他品牌。该测试没有加任何新生产门槛。

## 测试与上线判断

- 当前生产源码候选：GC/TT/NW × Classic 单源/多源，6/6 真 FFmpeg 编码、接收/执行/发布隔离测试通过。
- 新 guided 品牌/缺品牌测试，以及文案、BGM、guided、合同、RenderPlan 定向回归：92/92 通过。
- 修改及新增文件 ESLint 无错误、无告警；四个候选模块 node --check 通过。
- 没有新 Web UI 修改，未执行完整 Web 重建；没有生产业务 Canary、服务重启或全局功能开启。
- 前轮旧 bridge “字符串当 MP4”的基线失败不作为本轮的品牌通过证据，也没有为它修改生产规则；本轮上述 92 项定向回归均成功。

**受控试运行条件已具备，范围应限定为新任务且上游明确携带已识别品牌。** 用户另行批准后，才能安排该四模块的受控发布与独立作用域验证；本轮没有执行。不能直接全局打开两项功能开关，因为真实 NW 上游及旧 guided 请求是否传品牌尚无完整实证。缺品牌的任务继续采用现有安全路径并留待上游补传，不能猜品牌。

剩余风险：九格入口未验证（本轮明确排除）；NW 真实上游样本未观察到；旧 guided 样本确实缺字段；曲目可包含原视频中的说话或噪声，本轮没有逐首主观听审；多进程音乐可能偶发重复；NAS 不可用可回退同品牌缓存，零缓存时安全省略音乐。上述限制不应变成新的整批阻塞门槛。
