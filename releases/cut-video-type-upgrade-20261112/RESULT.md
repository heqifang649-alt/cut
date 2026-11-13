# 视频类型升级部署结果

用户于 2026-11-12 明确指示“部署”，适用范围为已交付的 OOTD / Unboxing 增量和最小回滚方案。

部署完成：2026-11-12 19:22 Asia/Shanghai。活动目录仍为 D:/CUT-Releases/20261030-production-first-r11，服务构建改为 .next-video-type-20261112，BUILD_ID boPj6NNvfX6RDEq_W1RKJ。HTTP 返回页面含该实际 BUILD_ID，不能把仅有磁盘构建当作服务确认。

## 安装范围与兼容

12 个模块列于 files.json / deployment.json，全部安装哈希与生产源码派生候选一致。通过补丁合入现有生产源码，保留生产 overlays；未整体部署开发目录。生产 executor 保留现有 OOTD original/fusion/safe-pool 分支，只有开箱任务进入独立顺序调度与 original renderer；未安装开发目录中其他连续性、密度、V2.2 或文案变更。

原网页构建 .next-owner-20261106 保留。仅更改 .env.local 的 CUTFLOW_NEXT_DIST_DIR，逐字反向校验其他内容未变化；无凭证被复制到证据。用户、模板、批次、队列、回执、多源记录哈希在最后核对时全部与部署前一致。data/storage 未复制或替换。

## 验证证据

- build.log：基于生产源码的隔离完整构建通过。
- candidate-tests-final.log：145/145，通过接收、协议、默认类型、重启/幂等、类型混合、质量和实际 FFmpeg fixture 渲染发布。
- ootd-production-comparison.json：当前生产与候选六种 OOTD 模式各单/双源，12 组调度结果相同。
- installed-tests.log：生产安装模块隔离复测初次 144/145；唯一失败来自测试适配器把 mock 模块字典的相对路径键替换为绝对 URL。只修正测试适配器键后 installed-adapter-retest.log 1/1 通过；无需更改生产代码。
- final-runtime.json：网页 200，未认证 health 401；实际服务 BUILD_ID 匹配。9 个新 PID 的阶段工作进程及 Bridge/Classic 心跳新鲜，全部普通 claims 仍 false，Fleet 11020 未重启。所有12个安装文件哈希一致；原文案轮换、OOTD合同、scheduler、生产 guided 扩展及配置保护哈希不变；持久化业务数据哈希不变。
- worker-reload.json：空闲任务锁内停止的 11 个相关子进程记录，原有 supervisors 自动重载。
- rollback-rehearsal：11 个原有模块备份字节恢复校验通过；新 video-type 模块的回滚路径保留为重命名文件，不删除数据。

部署辅助脚本首次启动网页时继承输入句柄，导致辅助进程等待未退出；网页已起来但原工作进程未被路径正则匹配。已修正启动输入隔离和进程匹配，完成空闲子进程重载并以新 PID/心跳再次核对。未因此发起业务任务、改状态或丢弃记录。

## 状态与限制

- CODE READY：候选构建及专项通过；旧开发 OOTD suite 的已复现基线 REVIEW 数量断言失败仍存在，见总交付报告。
- DEPLOY PENDING：本次增量否；其他工作区改动不在本次部署范围。
- DEPLOYED：是，实际服务 BUILD_ID、安装哈希和新进程证据见上。
- VERIFIED：部署运行与生产模块隔离行为通过；真实 OOTD/开箱新任务成片、真实视觉动作识别和 ALLWE 业务回执端到端验收未执行。不宣称完整生产业务验收。
- Git：本次没有提交，避免混入共享工作区其他任务改动；以明确文件及哈希绑定本次安装。
- 无生产新任务、付费 Provider 调用、历史回放、全局 claims 开启、Provider/模型/并发变更。

回滚入口为 scripts/deploy-video-type-20261112.mjs --rollback。要求空闲任务、安装文件未漂移、无待执行开箱任务，恢复本次原文件和原 dist，再重载必要子进程；备份哈希保护防止覆盖后续部署。实际生产回滚未执行，后续只在已授权异常条件成立时使用。真实新任务验收尚需明确素材和费用范围。
