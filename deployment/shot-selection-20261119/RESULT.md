# CUT 镜头优先选镜升级 · 生产恢复验收

审计截止：2026-11-19T12:48:44.385Z。**两条真实 Canary 渲染及 NAS 验证通过，用户确认 ALLWE 已回传；Classic 已恢复，保留全部历史隔离。完整独立生产验收仍有限制。**

- CODE_INSTALLED: PASS
- WORKER_LOADED: PASS_OBSERVED
- CANARY_RENDER_PASS: PASS_TECHNICAL
- NAS_DELIVERY_PASS: PASS
- ALLWE_CALLBACK_PASS: PASS_USER_CONFIRMED
- CLASSIC_RESUMED: RESUMED_WITH_POST_RESUME_INSTABILITY
- PRODUCTION_RECOVERED: NOT_FULLY_INDEPENDENTLY_VERIFIED

四模块当前 SHA256 与安装清单一致。实际 Classic PID171916 的 Debugger.getScriptSource 与四个磁盘文件逐字节一致，证明已加载。未修改算法或生产代码，未执行回滚，未开启全局 claims。

本轮受控 Canary 使用用户新提供的两个 OOTD taskId，通过已安装的真实 tick/context/executor、现行 Provider/模型和预算逐条执行；每条只允许一次 claim、并发1、关闭额外 NAS 扫描。两条均首次执行；历史任务逐记录对比保持不变。

- c54e0067-28e6-428a-9b69-1ef91708a30f：completed；10.033333秒、11317613字节、SHA256 3f912b9117650b1dbf3747d273fb691b65d4920855069dfe1eaec373735fa8e8、完整解码通过。
- 4ee904b6-e73f-40b0-8777-d61e67e92811：completed；9.4秒、10595778字节、SHA256 0a8009f5ab8ad463fbf1520f0c11c924bc0b83533c7d8c855bd28e4c51ac8f79、完整解码通过。

真实切点检测及候选、Quality 原始证据绑定、EDL、FFmpeg 成片、NAS 哈希/大小读回及完整解码已按 verified-*.json 分项记录。Quality 中仍有 REVIEW 告警；renderer productVisualReview=not_run 时不能伪称独立视觉验收通过。

两条任务没有 FINAL_MP4_SHORT_SHOT_REFUSE 或 SOURCE_INSUFFICIENT 失败。但成功样本不能证明大样本误拦截率改善，也未覆盖真实普通短镜头告警、真正素材不足及 Wrong SKU 负例。此前62项已安装模块隔离检查仍保留；它们不是本轮真实负例验收。

ALLWE：用户在本轮对两条 Canary 的回执核验请求明确回复“已回传”，记为 PASS_USER_CONFIRMED。未独立读取 ALLWE 导入/PENDING_REVIEW/播放日志；NAS completed 本身不作为上游消费证明。两条真实渲染/NAS和用户回传确认后，按本轮条件授权恢复 Classic。完整独立验收仍未确认，不声明无条件 PRODUCTION_RECOVERED。

预检发现旧回执之后的 runner、claim-pause 和 isolation 配置已发生变化，且原暂停早已被其他操作解除。两条较早新任务 e3ea0994…、e8d7d978… 已失败于 STATUS_REVISION_CONFLICT。本轮没有重跑它们。此前已释放的历史任务49063fc4…在本轮开始时在途，本轮只等待其自然完成，没有重置；它的成功不作为新 Canary 验收。

20:16:40 通过原控制器 rearm 并阻止后续认领，随后在旧 Worker 心跳边界设置 nextCycleDisabled。旧 supervisor exit watcher 指向旧 PID176140，未据此声称 PID171916 自然退出。20:41 在四类锁、零 lease/pending、旧 tick 已完成的保护下退出旧闲置进程，六个业务存储哈希不变，再由原 supervisor 恢复。新 PID134928 心跳 OPEN，四模块加载哈希再次通过；原维护控制已 complete。隔离配置前后哈希相同，历史15条 queued继续隔离，普通服务全局 NoClaim不变。

剩余验收：保留可复核的 ALLWE 消费日志及必要视觉复核，补充真实短镜头和负例/规模误拦截证据。不能将两条成功样本扩大为所有质量场景通过。历史隔离未释放、历史失败未重跑。

回滚：未发现需回撤四模块的已证实回归，不执行整体回滚。现有最小模块回滚脚本 scripts/deploy-shot-selection-20261119.mjs --rollback 仍受维护/空闲/哈希/锁保护；当前后续漂移导致原守卫不能通过，不可绕过。若真正 Canary 回归出现，先保留暂停和证据，再限定恢复对应现场备份，不覆盖 data/storage。

本目录上传 GitHub 的回执仅包含筛选后的运行/任务元数据、文件哈希、日志摘要、成片路径和状态；不上传凭证、环境内容、用户记录、Lease token、Provider 请求或媒体。原始19:13安装证据在父目录保留。

恢复后补充观察：Classic 后续出现进程更替及 records 数据锁超时；原 supervisor 自动重试后再次运行，见 post-resume-observation.json。134928仅为恢复当时PID，不代表当前持续健康。当前运行稳定性待确认，不能据此声明生产恢复成功。

用户随后明确确认“有其他操作方正在操作”。本轮停止所有生产变更，保留并发操作背景及现场；不能把后续进程更替归因于四模块，也不能声明当前独占或稳定验收通过。

CODE READY：四模块原检查完成；DEPLOY PENDING：四模块无待安装，生产恢复验收待完成；DEPLOYED：四模块实际安装及加载已确认；VERIFIED：两条真实渲染/NAS技术验收；ALLWE由用户确认，独立全链/视觉验收及恢复后运行稳定性未完成。
