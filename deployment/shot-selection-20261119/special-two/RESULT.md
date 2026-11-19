# 两条指定任务专项处理 · 2026-11-19

截至 2026-11-19T13:34:36.340Z。用户明确指定两条任务，不批量重跑其他历史任务。

- f3707bc9-c8af-4795-beb8-decded19430c：completed，attempt 2；One user-authorized bounded retry after source/installed-code preflight; original failure archived；8.5秒，\\192.168.120.60\新成片交付\批量剪辑素材\test\cutflow-link-only-20261015-180959-e6583121\classic-lan-v1\outbox\f3707bc9-c8af-4795-beb8-decded19430c\5bf1debb-7476-46db-a4be-fec9e996f0c1.mp4，SHA256 1761e59e9dfb234b6453ffaafd1adfd620d680ea494ea9ba5039799fda28c724，完整解码通过。
- 49063fc4-c9a7-41af-8338-a7dc0215a3ee：completed，attempt 3；Read-only revalidation of existing completion; no replay；8.6秒，\\192.168.120.60\新成片交付\批量剪辑素材\test\cutflow-link-only-20261015-180959-e6583121\classic-lan-v1\outbox\49063fc4-c9a7-41af-8338-a7dc0215a3ee\3bd51888-1542-4310-b970-82b4c1343c82.mp4，SHA256 ce962683277a5ef5e16deeb2d84c16e8f2eda77015d32f80e55074c850967a62，完整解码通过。

上游账号映射仅保留本地，不上传公开仓库。

f3707旧失败发生在17:01，早于四模块安装。原失败记录/状态/工作目录已完整归档。真实源文件哈希通过，新切点检测得到不跨切点的候选总20.083334秒，以原质量审核继续单次重试；不放宽安全门槛。49063已有成片复核，不重复生成。

其他任务逐记录不变=false；其余queued 8条全部隔离=false。

NAS completed状态和MP4是原正常回传通道；ALLWE实际消费端未独立读取，不冒称上游已收。质量REVIEW提示和renderer productVisualReview原样保留。

CODE READY/DEPLOYED沿用已安装四模块，无新增算法或生产代码部署；VERIFIED范围以各verified文件为准。

并发观察 2026-11-19T13:34:18.521Z：5条非目标任务从queued进入uploading，另8条queued的隔离已解除。本轮仅重新排队f3707；其他变化的具体操作者未独立核实，未覆盖或回滚并发操作。见concurrent-changes-observation.json。
