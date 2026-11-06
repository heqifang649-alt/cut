# GC Canary BGM 可听性修复（2026-11-02）

结果：已修复开发/独立候选中的音量断点，生成独立测试 MP4 并完成真实音频分量验证。尚未部署生产，没有覆盖或重新发布 Canary 原片，没有 Provider 调用，没有重跑任务。Canary 作用域仍锁定原单条，未扩大。

任务 d83ffadc-7664-482e-bec5-14b2230b788f，Batch 8e320510-c4c1-4f7f-8348-82df15a64a57。

## 根因与原片

原 NAS 文件哈希仍为 e46de2d4e01f638be54b8b39d94cd96108fc8109cd4b971393268f902da4f015；AAC LC、48kHz、双声道、约 195kbps。全片均值 -22.4 dBFS，峰值 -2.9 dBFS，存在原音。

选择的 GC 曲目为 NAS BGM/基督/TikSave.io_7385525741682806048.mp4，与缓存 sidecar 一致；缓存前 10.5 秒均值 -23.4 dBFS，峰值 -10.8 dBFS。

具体断点是 worker/brand-bgm.mjs 的 prepareBrandAudio：只要素材有音轨（不判断实际原音电平），原实现就将所有 BGM 固定乘 0.08（-21.94dB）。按全段均值，BGM 在淡出前约 -45.34 dBFS，容易被原音掩盖。不是 NAS 发布了旧片，也不是 FFmpeg 漏 map 音频；原片中确实有很低的 BGM。

追踪：verified_handoff GC → batch.brandBgmEnabled → batch-renderer prepareBrandAudio → selected cache WAV → volume=0.08 → 原音/BGM amix → 限幅/淡出 WAV → Renderer 将该 WAV 编码到最终 AAC → NAS 完整文件与经典版回执 hash 对齐。品牌音频在 EDL/RenderPlan 后由共享 Renderer 准备，不虚构 RenderPlan 内保存曲目字段。original-diagnosis.json 的 product/paths 与原 checkpoint 对照，audio-verification.json 为最终 AAC 独立验证。

前轮 CANARY 核验只证明最终音轨匹配混音 WAV，没有单独验证 BGM 分量音量，不能据此作为可听性验收。本轮更正这一缺口。

## 最小代码修复

仅 worker/brand-bgm.mjs，新增 audibleBgmGain；用 FFmpeg volumedetect 测量实际选中循环窗口，再计算增益：保留原音时 BGM 全窗口目标均值 -28 dBFS，纯音乐时 -22 dBFS，最大增益 10（+20dB）。这是本补丁采用的工程目标，不冒称行业统一标准。

静音/无法测量的音乐省略并警告，保留原音；增益受限时警告，沿用既有品牌隔离、原音拼接、限幅、末尾淡出和混音失败降级。本任务实际 gain 从 0.08 调整为 0.5888436554。没有修改 Hook/CTA、Quality Gate、Scheduler、Provider、回传或任何生产开关。

## 离线复现与最终 MP4 验证

完全复用原 EDL、既有原素材、原 GC 曲目缓存与已发布视频；隔离 selector 只预置该曲的同品牌缓存，目录发现失败为刻意的离线 fixture，不修改正式品牌映射、不重新随机换曲。reproduce.mjs 不导入任务 executor/quality Provider。直接调用候选 prepareBrandAudio，生成新混音；最终 MP4 复制原视频码流，仅编码新音轨。不是重跑整个历史任务。

产物：GC-canary-bgm-fixed.mp4，10.5 秒，1080×1920，完整视频/音频 FFmpeg -xerror 解码通过。
新 SHA256：7236658fd85280782928a1c93845445a3ed899320da3d21d1116975b7eecad50。

独立验证不是仅检查 AAC 或文件存在：分别生成仅原音参考，读取选定 GC 曲目参考，对最终 MP4 解码的 1–8 秒音频做双参考最小二乘分离。参考延迟补偿 -80 个 16kHz 采样；原片音乐系数 0.0794005，修复片 0.5861608，吻合实际 FFmpeg 增益；修复片归一化拟合误差 0.001915。

- 原片 BGM 分量：-42.45 dBFS（1–8 秒窗口；不同于全片均值估算 -45.34）。
- 修复后对应 GC 音乐分量：-25.09 dBFS，提升 17.36dB。
- 原音分量：原片 -20.779，修复片 -20.789 dBFS，基本不变；修复片音乐比原音低约 4.30dB。
- 修复后全片音轨均值 -21.5 dBFS，峰值 -3.1 dBFS，没有达到数字削波上限。
- 原/新视频编码流 hash 都为 845b8029172790fc3dfb4d669a6c6c444d4d7d8ab648660cc2bf9ad7605dff64，字幕、画面与节奏完全保留；Hook 抽帧目视为 Wear what you believe.，CTA 仍省略。

这些证据确认对应 GC 音乐实际进入最终 AAC，且恢复到合理可听量级，不声称已经完成人工听审。提供 original-audio-preview.mp3 与 fixed-audio-preview.mp3，仍需在正常播放设备上确认主观听感。

## 测试与保护

品牌/BGM 电平定向测试 6/6；另有两项真实 FFmpeg 场景通过：静音音乐被告警省略且原音 PCM 哈希不变；无原音曲目使用独立目标电平。ESLint 0 errors/0 warnings。

生产 module 与修复前备份 hash 仍一致；原任务 attempt=1、Provider budget used=6 不变，原成片 SHA 不变，详见 final-safety-check.json。没有修改 NAS 状态或经典版回执、没有新付费调用。未宣称本轮完整 Web build 或全站回归。

## 发布与回滚准备

独立补丁 patch/worker/brand-bgm.mjs；manifest.json 保存前后 SHA256；原 r11 文件 brand-bgm.before.mjs。发布范围仅这一运行时模块。

在试听确认并获得部署授权后：核对在线 before hash，在无活动 render/Classic 租约的维护窗口安装单文件并重载实际加载音频模块的 Runner；保留全局 claims、Provider、并发和现有单条 Canary 范围，不覆盖原片，不自动重跑原任务。安装后导入在线模块再做同一离线音频验证；未来新任务需要单独受控验证正常选择/混音/发布链，不能拿本独立文件当成已重新回传。

回滚：在同样无活动渲染的窗口将 brand-bgm.before.mjs 恢复为 r11 的 worker/brand-bgm.mjs 并核对 before SHA；重载同范围 Runner。可先通过既有独立品牌启用配置 disabled 停止后续品牌音频，但不删除原任务、缓存、输出或回执。

当前状态：未部署，离线机制和实际音乐分量验证通过；尚需正常播放设备听感确认、授权部署及上线后的新任务验收，才可放大 Canary 范围。
