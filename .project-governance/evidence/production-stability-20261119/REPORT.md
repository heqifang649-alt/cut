# CUT 生产稳定与历史任务收尾（2026-11-19）

证据截止：2026-11-19T14:29:44.534Z（UTC；北京时间 +08:00）。本报告覆盖真实生产观察和指定历史任务；广告独立动态验收单列，不能用技术成功代替。

| 字段 | 结果 |
| --- | --- |
| PRODUCTION_STABILITY | 观察窗口内技术稳定；部署后 40.1 分钟、40 次快照；指定历史队列已收口。不代表长期零故障保证。 |
| LOCK_TIMEOUT_ROOT_CAUSE | 历史死进程持有 records 锁及 recovery guard，后继消费者的 15 秒等待早于安全过期恢复；最后失败 12:58:25.118Z。观察中无新增超时。原进程退出诱因未被直接证实，未更改锁安全策略。 |
| STATUS_REVISION_CONFLICT_STATUS | 已部署最小修复：内部 lease claim 保留公开 updatedAt，防止同 revision 不同公开快照。旧模块恢复 uploading/editing 均可复现，候选三路径通过。历史冲突 8 条保留、不重试；不能逐条断言均为同一根因。 |
| WORKER_RESTART_STATUS | 当前 PID 62276、父进程 23336，restartCount 62；授权维护计划切换 1 次（旧 PID396220 正常 code0 退出），窗口内意外重启 0 次；唯一 Classic 消费进程。 |
| REAL_TASK_SUCCESS_RATE | 原四条验收样本 4/4；本轮历史 13/13 完成后端闭环（其中补丁后受控历史 8/8）；部署后自然新任务 4/11 已核验，失败 0，其余可能在途。不同队列分母独立，不能称全量历史成功率100%。 |
| HISTORICAL_ISOLATED_REMAINING | 目标13条中：完成 13、后端核验 13、queued 0、failed 0。当前隔离 queued 0；另有原有10条范围外隔离策略保留。 |
| ALLWE_CONSUMPTION_VERIFIED | 21 条真实输出有消费者写入的 yiying-classic-import/1 回执，task/manifest/batch/output SHA256与大小匹配，NAS成片完整解码；状态 PENDING_REVIEW。外部UI播放、最终审核与运行构建身份未验收。 |
| VISUAL_QA_RESULT | 分层验收：独立于自动质量标记的抽帧查看已做；完整动态广告观感和最终人工审核仍待完成。技术 EDL 最短计划镜头 1.300 秒，见 qa-technical.json，不能据此排除所有内部残片。 |
| UNRESOLVED_RISKS | 原始异常退出诱因；未获得全部历史冲突公开快照；无生产自然 lease 恢复样本；ALLWE回执自报 development/unconfigured；视觉动态与外部UI待验；外部收费台账未核对；只读巡检依赖用户登录且不推送通知。 |

## 已部署范围与证据

用户授权“部署”“授权你暂停其它任务，部署后安全放行”。先隔离8条未启动任务，让5条在途任务自然完成；在 tick 边界、零 lease/pending、现有安全锁保护及业务存储哈希一致条件下，仅安装 lib/classic-multisource.mjs。旧消费者正常退出后由原 Supervisor 启动新消费者；未强杀、删锁、清队列、篡改回执或开启全局 claims。

实际生产根目录：D:/CUT-Releases/20261030-production-first-r11。安装时间：2026-11-19T13:49:39.486Z。原 SHA256：dd8853f15f8b210794bfadffe8baa1e014fcaa21beb7fb0b7b84e5c7d7901885；部署 SHA256：cf5407f654210f390adf0a2c467f158519e22d536019328208c0211c3bd7be4a。resident 源码哈希已核对。旧版业务六库安装前后哈希一致；剪辑算法、Provider、并发5、短镜头前处理和现有质量规则保留。

CODE READY：相关开发回归 52/52、生产派生候选回归 11/11；含同 revision 真冲突仍拒绝的负向检查。DEPLOY PENDING：本状态修复无。DEPLOYED：是，安装哈希与 PID62276 resident 哈希匹配。VERIFIED：真实新任务和本表已核验历史任务闭环；恢复路径以隔离复现验证，无自然恢复生产样本。回滚备份本地保留，按 DEPLOY_PLAN.md 的安全空闲及哈希门禁执行，本轮未回滚。

revision-reproduction.json、installed-runtime.json 和 DEPLOY_PLAN.md 记录各自取证时点的状态；其中部署前的 deployed:false / pending 字段不是当前状态，以本报告和 deployment.json 为准。development-regression.log 为开发测试，candidate-regression.log 为生产依赖隔离测试，均不能替代真实业务证据。

## 历史任务清单

historical-inventory.json 是只读核对时点：13个原始 taskId、acceptedAt、manifest、所有素材/商品参考图大小与SHA256均一致。0f42bc4f 与一条失败记录素材相同，e98f1fba 与三条失败记录素材相同；对应旧记录无成片，未重试旧ID。所有13条的收费策略为 settled_upstream_no_additional_charge；未发起额外收费操作，但本报告不冒充独立财务台账审核。

后8条先按 acceptedAt 放行2条，完成CUT→NAS→ALLWE核验。用户随后明确授权“部署后其它任务放行吧，不用一条放行了”，因此停止仅负责放行的维护脚本，一次释放该13条范围内余下6条；范围外10条隔离保持，生产Worker持续运行，现有并发上限5和安全检查不变。该后续专项授权变更了最初小批次策略，未冒称全部逐批执行。remaining-six-release.json保存前后清单及授权，completion-events.jsonl记录只读跟踪。batch-events.jsonl包含早期条件不足的安全拒绝记录，均保留。

| 原任务ID | 接收时间 UTC | 最终观测状态 | attempt | CUT/NAS/ALLWE |
| --- | --- | --- | --- | --- |
| 0f42bc4f-149a-4281-a239-bf0594968fb8 | 2026-11-19T09:45:38.548Z | completed | 1 | 已核验 |
| e98f1fba-a089-4ac5-8186-f4eb789e668f | 2026-11-19T09:45:45.727Z | completed | 1 | 已核验 |
| b7423d3c-ead8-4354-935e-44eea3011df1 | 2026-11-19T09:46:41.978Z | completed | 1 | 已核验 |
| e8f44a6f-4545-4744-b456-2437a69c19a3 | 2026-11-19T09:52:25.276Z | completed | 1 | 已核验 |
| 0eb80a34-1efe-46e6-ba34-ea68d0c760c1 | 2026-11-19T09:58:03.222Z | completed | 1 | 已核验 |
| 81953e40-e70f-49a3-a336-d54e84c40e85 | 2026-11-19T10:02:19.285Z | completed | 1 | 已核验 |
| 73bbe430-6600-4faf-ac36-8451fc23030c | 2026-11-19T10:02:36.736Z | completed | 1 | 已核验 |
| e5f8431a-790a-4576-8879-222b227a1a97 | 2026-11-19T10:12:45.581Z | completed | 1 | 已核验 |
| 13b2b2b5-f699-4f81-81c0-2ba8ece1cc10 | 2026-11-19T10:13:51.428Z | completed | 1 | 已核验 |
| 7b8cc7a0-716e-44fb-9405-829f62d4816d | 2026-11-19T10:17:07.730Z | completed | 1 | 已核验 |
| fb2f8afc-398b-401b-aa6f-33f10f0120b0 | 2026-11-19T10:18:43.924Z | completed | 1 | 已核验 |
| 6e00f280-dd86-41cf-abef-a09b629599b7 | 2026-11-19T10:20:55.763Z | completed | 1 | 已核验 |
| acff0762-ae83-48c6-a69d-4a051c985722 | 2026-11-19T10:27:55.363Z | completed | 1 | 已核验 |

当前全库仅作背景统计：{"failed":43,"review":5,"completed":239,"uploading":5,"queued":2}，lease=5，pending=0。原有 failed/review 记录未被重写或重跑。

## 视觉抽查与限制

已人工查看四条原验收样本的接触表，以及历史0f42、73bbe、e5f843、7b8cc和补丁后自然0d8223的250ms抽帧接触表，共9条。红、蓝Jesus毛衣分别对照正反面商品参考图，图案、文字及正反面一致；紫色Mongo款抽样前后图案一致。自然新任务0d8223保留正面火灯文字及背面 THE LIGHT SHINES / JOHN 1:5。73bbe白绿毛衣和e5f843绿色书店开衫的前景/特写文字与图案一致，样本未显示背面，不能推断背面展示合格。

抽帧范围内未见混款、明显0.2–0.5秒孤立残片或被证实的重复同段素材。部分角度相似、自然0d8223两次背面展示和 quality:review 提示保留；EDL范围重叠另见 qa-technical.json。4fps不能证明动作连接自然、声画卡点及全部短闪帧均合格，完整动态广告验收与消费者PENDING_REVIEW不可跳过。接触表尾部黑格为补齐布局，不是成片黑帧证据。

## 后续正常维护

用户另明确要求“新任务也放开，正常接受不做限制”。当前正常入口 gate=OPEN，新任务不加人工放行或新增隔离，自动接收/排队/执行；并发、素材完整性、幂等和质量安全检查保持。见 new-task-ingress.json。

保留既有 Worker Startup / Morning Website 及 Supervisor 自动运行，不修改原计划任务指向。新增 Cutflow Readonly Stability Monitor，每5分钟、当前用户Interactive会话运行，首轮计划执行退出码0；脚本独立部署于 D:/CUT-Maintenance/stability-20261119/monitor.mjs。记录唯一消费者、心跳、PID变化、restartCount增量、长锁、模块漂移、新失败及队列；latest.json、attention.json 和每月 observations 位于该目录 monitor 子目录。只写维护日志，不写生产。没有自动重启/重试/删锁/放行，也没有对外通知；用户未登录时不保证巡检运行。现有启动任务同样不能当作无人登录/机器重启验收证据。

例行查看 attention.json 后核对实际状态和新增日志；lastFailureReason保留旧异常时按 lastFailureAt 区分历史，不能据此判断正在报错。异常时暂停扩展及后续批次、保留在途与证据，按既有门禁处理。稳定后维持已验证选镜逻辑，不继续调整算法。版本、计划任务安装和日志证据见本目录及 SHA256SUMS.json。

