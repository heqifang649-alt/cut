# CUT 音频规则：仅品牌 BGM（2026-11-02）

## 状态

- CODE READY：音频候选与独立补丁已完成，可审阅。
- VERIFIED：仅隔离代码/实际 MP4/音频规则验证通过；不是生产生效或全站回归声明。
- DEPLOY PENDING：等待明确部署授权及上线窗口。
- DEPLOYED：否。未写入 r11、未重启生产、未扩大单条品牌 Canary、未重跑历史任务；Provider 新调用 0。

独立产物：GC-canary-BGM-only.mp4。原 GC Task d83ffadc-7664-482e-bec5-14b2230b788f 的视频、EDL 和既有音乐缓存只读复用，原成片/原始素材未修改。此候选取代上一轮尚未部署的“保留原音、提升音乐增益”候选，不能再部署旧混音修复。

## 最小代码变更

独立发布补丁仅两个运行时模块，均基于当前 r11，不夹带工作区 Scheduler/short-shot 等改动：

1. worker/brand-bgm.mjs:83 起 normalizeBrandTrack、109 起 prepareBrandAudio：删除输入片段音轨读取和 amix。仅选择同品牌音乐，腐坏/无声/归一化失败最多换同品牌另一个候选；无可用曲或品牌启用关闭则返回 path=null 并警告。不会退回原音、模板或其他品牌。
2. worker/batch-renderer.mjs:932 起和 1059/1101 起：所有最终渲染都走品牌音频/无音轨规则，禁止模板音乐回退；仅 map 视频和归一化品牌音乐；音乐不可用时 -an 输出视频-only。单源、多源和 guided 使用同一共享 Renderer，不新增路由。音频策略签名升级，避免新渲染误用旧混音缓存；未主动调用任何历史渲染。

音频导出元数据同步为 source_audio=mute、mute_original_audio=true，BGM 指向实际归一化文件，不在可编辑时间线重新叠入原音。不修改 Hook/CTA、视频时间线、Quality Gate、Scheduler、Provider、并发、时长底线或 NAS/经典回传协议。

正式品牌映射不变：GC→基督，TT→亚文化，NW→明确 NW 配置；不把 pagewings 认作 NW。单条品牌启用作用域不变。注意：未来部署此规则后，未启用品牌音乐或缺品牌的任务会按规则无音轨出片，不再借模板/原音。这不等于全局开启品牌选择。

## 音乐长度与响度

- 音乐够长直接截取；不足则重复同一首。采用 asplit/acrossfade，默认 0.2 秒等功率短交叉淡化，极短有效素材使用约 0.125–0.2 秒。实际结果不因交叉淡化而短于成片。
- 开头 0.15 秒淡入；结尾 0.7 秒淡出。对裁切/循环/淡化后的实际成片窗口做两遍 loudnorm，初始目标 -16 LUFS、LRA=11；normalizer TP=-2 dBTP 为 AAC 编码后 <=-1 dBTP 留余量。线性归一化可用时使用 linear=true，没有新增音频服务或付费调用。
- 所有音频异常均为本地可降级错误，最终可以没有音轨，不能阻塞正常视频剪辑。

## GC 真实素材独立 MP4 验证

仅使用原选中的 GC 曲目：BGM/基督/TikSave.io_7385525741682806048.mp4，cache sidecar 对齐。本测试把该曲预置到隔离同品牌缓存，目录发现失败为刻意的离线 fixture，没有更改正式品牌配置、重新随机换曲或写入 NAS。

- 实际时长 10.500000 秒，1080×1920，1 个视频流、1 个 AAC 音频流，全量视频和音频解码通过。
- 最终 AAC 实测输入响度 -16.01 LUFS，True Peak -5.37 dBTP，LRA 1.40 LU。以 measurement 的 input_i/input_tp 为最终 MP4 指标，不误用测量滤镜自己的 output_i/output_tp。
- 对应归一化品牌 BGM 参考与最终音轨相关系数 0.9999063293067597；双参考分离中品牌音乐系数 0.99864822552096，原音系数 -0.0001947275037169109，符合 AAC 量化噪声范围内无原音的结果。更直接的代码证据：新的 prepareBrandAudio 不读取 product.segments；最终 FFmpeg 明确只 map 0:v 和 1:a，不 map 0:a。
- 原视频编码流 hash 与新片完全一致：845b8029172790fc3dfb4d669a6c6c444d4d7d8ab648660cc2bf9ad7605dff64，因此画面、Hook、CTA、镜头时间线均未改变。新片不是原历史任务重跑，而是独立音频验证重封装。
- 新 MP4 SHA256：a9c06fc318842f5f459b1159798960f906ed9c7bbe6de38ce710a061f2e30412
- 原 NAS 成片 SHA256 保持 e46de2d4e01f638be54b8b39d94cd96108fc8109cd4b971393268f902da4f015。未覆盖旧 MP4、NAS status 或经典版回执。
- 听感文件 GC-BGM-only-preview.mp3 为试听副本；客观电平、峰值、音轨数量及参考音乐内容已验证，不冒称已完成人工听审。实际验收指标来自 MP4 AAC，不是 MP3。

## 长度与故障测试

length-tests.json 保存三条真正编码并测量的 MP4：

| 曲长 | 视频 | 循环 | 最终 LUFS | 最终 dBTP |
|---|---:|---:|---:|---:|
| 1.73 秒 | 8 秒 | 6 次，交叉淡化 | -16.03 | -13.64 |
| 8 秒 | 8 秒 | 不循环 | -16.04 | -14.61 |
| 12 秒 | 8 秒 | 不循环 | -16.04 | -14.61 |

三条均只有 1 条音乐音轨、完整解码通过；滑动 RMS 未出现静音缺口，最大内部逐采样跳变 <0.017，开头和结尾衰减比通过，记录见 continuity 字段。合成正弦信号只用于边界连续性/长度验收，真实音乐另由上方 GC 测试覆盖，不能将合成音效冒充品牌音乐。

- 新音频故障/长度单元集成测试 6/6，通过不读取 source segments 的 getter 哨兵断言；验证损坏后换同品牌曲、全部损坏/禁用时无音轨回退。
- 开发树新音频+BGM 定向测试 10/10。
- Classic 单/双源三品牌 6 格、v1 双源/v2 单/双/三/八源回归以及品牌开关/隔离测试，合计 22/22；真实 FFmpeg 编码与隔离 NAS 发布，未调用 Provider。
- 新增 guided 音频-only 真实 Renderer 验证 1/1：有效 GUIDED_POLICY fixture、997Hz 输入原音，输出仅一条品牌音乐音轨。
- 新增禁用音乐 Renderer 验证 1/1：输入含 997Hz 原音并提供模板音乐，但最终无任何音轨；证明不回退原音或模板，也不因 guided/music 硬门槛阻塞。
- r11 对齐的 guided 全套 40/41；唯一失败为既有 one-shot execution policy 测试，预期 failed、实际 batch_queued，早于音频处理。本轮未修改的 r11 模块同样失败。工作区 guided+copy 测试 51/53，另一个失败是开发测试期待 durationMax=18 而 r11 实际 undefined，也已用原 r11 bridge 对照复现。没有为了通过它们改变领取/时长/Scheduler。不能把该现状写成全部回归无失败。
- lint 0 errors；候选 Renderer 两个既有 no-unused-expressions warning 与 candidate 缺 pages 提示已记录。独立音频模块及新主测试开发侧 lint 无告警。未做 Web build，未声明生产运行已加载候选。

## 发布与回滚准备

patch/ 仅两模块；rollback/ 是当前 r11 两模块原始字节；manifest.json 保存 before/after SHA256。其他 lib/worker/config/standards 与 r11 逐文件相同。生产原任务 attempt=1、原 Provider used=6 仍不变。没有 Provider 凭证进入补丁或报告。

部署步骤（仅方案，未执行）：
1. 明确确认新音频业务规则适用于所有新成片，且未启用/缺品牌时采用无音轨；获得部署及必要 Runner 重载授权。
2. 维护窗口确认无活动渲染/Classic 租约，核对在线 before hash；只安装这两个模块，保持 claims、并发、Provider、既有单条 Canary 作用域不变。
3. 由原 supervisor 重建受影响的空闲 Runner；核对实际加载版本、健康/心跳、两个模块 hash；安装模块再跑隔离音频验证。
4. 新任务的真实发布/经典回收还需受控验证；不得为此自动重跑旧任务或覆盖旧片，也不自行增加付费调用。隔离测试不能冒充新代码生产闭环。

紧急音频降级：现有独立品牌启用开关 disabled 后，新 Renderer 只出视频，无原音、无模板音乐。此开关不修改接单或 claims，不中断已开始渲染。

文件级回滚：在安全窗口成对恢复 rollback/ 中两个原 r11 模块、核对 before hash，并经授权重载相同 Runner。注意恢复旧代码也会恢复旧原音混音业务行为；如该行为不再允许，应先保持新 Renderer 的视频-only 降级，而不是未经确认恢复旧音频规则。保留全部任务、证据、旧片与独立测试片。
