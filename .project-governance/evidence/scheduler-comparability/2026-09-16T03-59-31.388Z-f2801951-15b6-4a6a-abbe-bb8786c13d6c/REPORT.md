# Scheduler-only 可比性分析与 12 Case 审计

Baseline SHA256: 3f2c4d72070c31d65d64dec1e1785758a1e3b343299d227d993af68437e9de5c

仅离线审计/Shadow 反事实实验；未修改 Scheduler、Hard Safety、Gate、Provider、Ground Truth 或 Renderer。

## Comparable Subset

口径：Product-level complete analysis + completed existing safety admission + >=1 eligible shot + identical original input; ANALYSIS_INCOMPLETE and QUALITY_BLOCKED excluded. Also rerun both against identical shared eligible input.

结果：{"products":42,"oldSuccess":40,"v2Success":35,"oldSuccessRate":0.9523809523809523,"v2SuccessRate":0.8333333333333334,"oldFailToV2Success":0,"oldSuccessToV2Fail":[{"case":"1315a6e8-d78a-4c79-904b-731c42b59c1c/2","reason":"INSUFFICIENT_MATERIAL"},{"case":"c0f1765d-bf55-41e2-a296-5aababcfe149/TT1-M1","reason":"INSUFFICIENT_MATERIAL"},{"case":"c0f1765d-bf55-41e2-a296-5aababcfe149/TT2-M1","reason":"INSUFFICIENT_MATERIAL"},{"case":"d493c143-83f6-4424-b87b-08af45332e33/TT1-M1","reason":"INSUFFICIENT_MATERIAL"},{"case":"d493c143-83f6-4424-b87b-08af45332e33/TT2-M1","reason":"INSUFFICIENT_MATERIAL"}],"levels":{"A":6,"B":21,"C":8},"insufficientMaterial":7}

实验：{"cases":12,"upstreamEmpty":5,"mvaWithoutSourceRelaxation":4,"mvaWithReviewedDistinctPairs":7,"mvaTemporalOnlyUpperBound":7,"sourceOnlyVerifiedRescue":4,"sampledVisualReviewSupportedRescues":7,"projectedComparableSuccess":42,"projectedComparableSuccessRate":1,"projectedOldFailToMvaSuccess":2,"projectedOldSuccessToMvaFail":0,"trueSchedulerMaterialShortageAfterReviewedMva":0,"unverifiedVisualCases":0}

时长为实际可剪区间总长，未渲染；沿用 4 秒最低时长。旧证据缺少 complete 标记时，仅在当前产品全部 Shot 记录有效时判为完成。0 Eligible 与质量/分析阻塞不进入分母。

## 全部 Case

### Case 1: 1315a6e8-d78a-4c79-904b-731c42b59c1c / 2

Eligible=3；Source=1；Old=success；Comparable=true；分类=STRUCTURAL_RULE_TOO_STRICT

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|
| 65334551ef683a68d8b8c759229ab285 | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\1315a6e8-d78a-4c79-904b-731c42b59c1c\products\2.mp4 | 0–3.2 | 3.200 | product,end,opening | 0.94/0.5437 | 0.73/0.8525 |
| ce03992cf37be53c3be5cbd6b78b6ef9 | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\1315a6e8-d78a-4c79-904b-731c42b59c1c\products\2.mp4 | 4.84–8.04 | 3.200 | product,end,opening,variation | 0.95/0.5198 | 0.8/0.8875 |
| ee43961d11c68bdacb2d94585f16656d | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\1315a6e8-d78a-4c79-904b-731c42b59c1c\products\2.mp4 | 2.42–5.62 | 3.200 | product,end,opening,detail | 0.91/0.5905 | 0.74/0.8462 |

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。
- C: PAIR_CONFLICTS; 需要 3 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：

- 65334551ef683a68d8b8c759229ab285 + ce03992cf37be53c3be5cbd6b78b6ef9: same_source_visual_difference_unverified
- 65334551ef683a68d8b8c759229ab285 + ee43961d11c68bdacb2d94585f16656d: source_overlap
- ce03992cf37be53c3be5cbd6b78b6ef9 + ee43961d11c68bdacb2d94585f16656d: source_overlap

仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：{"shotIds":["65334551ef683a68d8b8c759229ab285","ce03992cf37be53c3be5cbd6b78b6ef9"],"duration":6.3999999999999995}；仅时间不重叠的条件上限：{"shotIds":["65334551ef683a68d8b8c759229ab285","ce03992cf37be53c3be5cbd6b78b6ef9"],"duration":6.3999999999999995}。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

视觉审计：{"batchId":"1315a6e8-d78a-4c79-904b-731c42b59c1c","productId":"2","inputHash":"c10f5c6eba8c3b4f99cc259943b2531cc7aace7d9f1b1a4bd258764f2f2213fa","reviewer":"assistant_visual_inspection","scope":"existing_3_frames_per_interval_only","observation":"早段为白色球衣正面/领口展示，晚段为侧身转向背面及背部图案；采样画面内容不同。","fullVideoReviewed":false,"preferredMvaShotIds":["65334551ef683a68d8b8c759229ab285","ce03992cf37be53c3be5cbd6b78b6ef9"],"distinctPairs":[{"shotIds":["65334551ef683a68d8b8c759229ab285","ce03992cf37be53c3be5cbd6b78b6ef9"],"visuallyDistinct":true,"evidenceRef":".project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-01.jpg","basis":"non_overlapping_intervals_and_observed_front_vs_back_content"}]}

已审阅 MVA 组合：{"shotIds":["65334551ef683a68d8b8c759229ab285","ce03992cf37be53c3be5cbd6b78b6ef9"],"duration":6.3999999999999995}；CTA 放在该组合末镜，不增加 Shot。

### Case 2: 3a1d6f81-21f4-41b1-a8f8-9ecca662042f / 1

Eligible=3；Source=1；Old=failed；Comparable=true；分类=STRUCTURAL_RULE_TOO_STRICT

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|
| 67904c45449c862b869e2217ff70d29d | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\1.mp4 | 2.42–5.62 | 3.200 | product,end,opening,detail | 0.92/0.5663 | 0.78/0.8650 |
| c26afa226238f422b34797b1cc60a8fd | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\1.mp4 | 4.84–8.04 | 3.200 | product,end,opening,variation | 0.93/0.5786 | 0.68/0.7013 |
| cb4040b30f18360ba3574010fe4b48bd | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\1.mp4 | 0–3.2 | 3.200 | product,end,opening | 0.93/0.5659 | 0.78/0.8713 |

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。
- C: PAIR_CONFLICTS; 需要 3 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：

- 67904c45449c862b869e2217ff70d29d + c26afa226238f422b34797b1cc60a8fd: source_overlap
- 67904c45449c862b869e2217ff70d29d + cb4040b30f18360ba3574010fe4b48bd: source_overlap
- c26afa226238f422b34797b1cc60a8fd + cb4040b30f18360ba3574010fe4b48bd: same_source_visual_difference_unverified

仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：{"shotIds":["c26afa226238f422b34797b1cc60a8fd","cb4040b30f18360ba3574010fe4b48bd"],"duration":5.4}；仅时间不重叠的条件上限：{"shotIds":["c26afa226238f422b34797b1cc60a8fd","cb4040b30f18360ba3574010fe4b48bd"],"duration":5.4}。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

视觉审计：{"batchId":"3a1d6f81-21f4-41b1-a8f8-9ecca662042f","productId":"1","inputHash":"4b941506364345e64a59dcde0f5bacd3a17abfb59f0832b5d8ed179d9dc5af49","reviewer":"assistant_visual_inspection","scope":"existing_3_frames_per_interval_only","observation":"早段为米白T恤正面整体与胸前十字，晚段为背部大幅图案展示；内容不同。","fullVideoReviewed":false,"preferredMvaShotIds":["cb4040b30f18360ba3574010fe4b48bd","c26afa226238f422b34797b1cc60a8fd"],"distinctPairs":[{"shotIds":["cb4040b30f18360ba3574010fe4b48bd","c26afa226238f422b34797b1cc60a8fd"],"visuallyDistinct":true,"evidenceRef":".project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-02.jpg","basis":"non_overlapping_intervals_and_observed_front_vs_back_content"}]}

已审阅 MVA 组合：{"shotIds":["c26afa226238f422b34797b1cc60a8fd","cb4040b30f18360ba3574010fe4b48bd"],"duration":5.4}；CTA 放在该组合末镜，不增加 Shot。

### Case 3: 3a1d6f81-21f4-41b1-a8f8-9ecca662042f / 2

Eligible=3；Source=1；Old=failed；Comparable=true；分类=STRUCTURAL_RULE_TOO_STRICT

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|
| 77591af0038853391b6a8b30b1f8194a | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\2.mp4 | 0–3.2 | 3.200 | product,end,opening | 0.93/0.5857 | 0.78/0.7512 |
| d5a831bce7215b844f8ba9d866df257c | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\2.mp4 | 2.42–5.62 | 3.200 | product,end,opening | 0.9/0.5775 | 0.81/0.8875 |
| dc17e99f42717d8afe2fc08e91a82b42 | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\2.mp4 | 4.84–8.04 | 3.200 | product,end,opening,variation | 0.89/0.5875 | 0.84/0.9037 |

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。
- C: PAIR_CONFLICTS; 需要 3 区间，最多兼容 1（这些区间共 3.200s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：

- 77591af0038853391b6a8b30b1f8194a + d5a831bce7215b844f8ba9d866df257c: source_overlap
- 77591af0038853391b6a8b30b1f8194a + dc17e99f42717d8afe2fc08e91a82b42: same_source_visual_difference_unverified
- d5a831bce7215b844f8ba9d866df257c + dc17e99f42717d8afe2fc08e91a82b42: source_overlap

仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：{"shotIds":["77591af0038853391b6a8b30b1f8194a","dc17e99f42717d8afe2fc08e91a82b42"],"duration":5.4}；仅时间不重叠的条件上限：{"shotIds":["77591af0038853391b6a8b30b1f8194a","dc17e99f42717d8afe2fc08e91a82b42"],"duration":5.4}。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

视觉审计：{"batchId":"3a1d6f81-21f4-41b1-a8f8-9ecca662042f","productId":"2","inputHash":"664de2c542a19cd929db1cf3b80f6f0320115071f6ec38d32dd5f4f52f7faefe","reviewer":"assistant_visual_inspection","scope":"existing_3_frames_per_interval_only","observation":"早段为正面全身及走近，晚段从胸前细节转向背部图案；内容不同。","fullVideoReviewed":false,"preferredMvaShotIds":["77591af0038853391b6a8b30b1f8194a","dc17e99f42717d8afe2fc08e91a82b42"],"distinctPairs":[{"shotIds":["77591af0038853391b6a8b30b1f8194a","dc17e99f42717d8afe2fc08e91a82b42"],"visuallyDistinct":true,"evidenceRef":".project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-03.jpg","basis":"non_overlapping_intervals_and_observed_front_vs_back_content"}]}

已审阅 MVA 组合：{"shotIds":["77591af0038853391b6a8b30b1f8194a","dc17e99f42717d8afe2fc08e91a82b42"],"duration":5.4}；CTA 放在该组合末镜，不增加 Shot。

### Case 4: dba0174c-6ee7-47e5-b356-91633b12d4f9 / gc1-m2

Eligible=0；Source=0；Old=failed；Comparable=false；分类=UPSTREAM_NO_ELIGIBLE_MATERIAL_NOT_SCHEDULER

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|

没有 Eligible Shot；上游导入记录：

- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (1).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (2).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (3).mp4: reject, tech:duration_invalid

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- C: ELIGIBLE_INTERVAL_COUNT; 需要 3 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：


仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：null；仅时间不重叠的条件上限：null。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

### Case 5: 0c8c23d7-69fc-42af-a93d-5a1b3103ec1f / gc1-m2

Eligible=0；Source=0；Old=failed；Comparable=false；分类=UPSTREAM_NO_ELIGIBLE_MATERIAL_NOT_SCHEDULER

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|

没有 Eligible Shot；上游导入记录：

- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (1).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (2).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (3).mp4: reject, tech:duration_invalid

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- C: ELIGIBLE_INTERVAL_COUNT; 需要 3 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：


仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：null；仅时间不重叠的条件上限：null。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

### Case 6: 70e3f544-c59c-4236-964c-a88ac958bc47 / gc1-m2

Eligible=0；Source=0；Old=failed；Comparable=false；分类=UPSTREAM_NO_ELIGIBLE_MATERIAL_NOT_SCHEDULER

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|

没有 Eligible Shot；上游导入记录：

- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (1).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (2).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (3).mp4: reject, tech:duration_invalid

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- C: ELIGIBLE_INTERVAL_COUNT; 需要 3 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：


仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：null；仅时间不重叠的条件上限：null。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

### Case 7: c0f1765d-bf55-41e2-a296-5aababcfe149 / TT1-M1

Eligible=6；Source=2；Old=success；Comparable=true；分类=STRUCTURAL_RULE_TOO_STRICT

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|
| 09c829e23757d9bfc96cb035f12dc601 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (1).mp4 | 2.4–5.6 | 3.200 | product,end,opening | 0.86/0.3938 | 0.74/0.7250 |
| 41712842360327dd0972b96475f332e9 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (2).mp4 | 2.42–5.62 | 3.200 | product,end,opening,detail | 0.93/0.4553 | 0.76/0.7425 |
| 45a0216cb82a1c121cde529d49efc8e4 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (1).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.97/0.4447 | 0.78/0.7600 |
| 7f4727e9bae3cf7e314b74fe1e5488f6 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (2).mp4 | 4.84–8.04 | 3.200 | product,end,opening,variation | 0.93/0.4308 | 0.72/0.7238 |
| a063619a3db5d7b4ce26fb746727bb9f | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (2).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.97/0.4765 | 0.72/0.7288 |
| ef525191d7d1dedf083e0430309a5c88 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (1).mp4 | 4.8–8 | 3.200 | product,end,opening,detail | 0.93/0.4339 | 0.78/0.7550 |

各 Level 的独立失败诊断：

- A: PAIR_CONFLICTS; 需要 5 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- B: PAIR_CONFLICTS; 需要 4 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- C: PAIR_CONFLICTS; 需要 3 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：

- 09c829e23757d9bfc96cb035f12dc601 + 45a0216cb82a1c121cde529d49efc8e4: source_overlap
- 09c829e23757d9bfc96cb035f12dc601 + ef525191d7d1dedf083e0430309a5c88: source_overlap
- 41712842360327dd0972b96475f332e9 + 7f4727e9bae3cf7e314b74fe1e5488f6: source_overlap
- 41712842360327dd0972b96475f332e9 + a063619a3db5d7b4ce26fb746727bb9f: source_overlap
- 45a0216cb82a1c121cde529d49efc8e4 + ef525191d7d1dedf083e0430309a5c88: same_source_visual_difference_unverified
- 7f4727e9bae3cf7e314b74fe1e5488f6 + a063619a3db5d7b4ce26fb746727bb9f: same_source_visual_difference_unverified

仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=true, C=true。此项不是视觉验收通过。

只改 MVA：{"shotIds":["09c829e23757d9bfc96cb035f12dc601","41712842360327dd0972b96475f332e9"],"duration":6.4}；MVA + 已审阅差异证据：{"shotIds":["09c829e23757d9bfc96cb035f12dc601","41712842360327dd0972b96475f332e9"],"duration":6.4}；仅时间不重叠的条件上限：{"shotIds":["09c829e23757d9bfc96cb035f12dc601","41712842360327dd0972b96475f332e9"],"duration":6.4}。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

视觉审计：{"batchId":"c0f1765d-bf55-41e2-a296-5aababcfe149","productId":"TT1-M1","inputHash":"5fb2434803d2356b926f8828cd5e29e7ed81cf7213475211daea1ec57b1b26e4","reviewer":"assistant_visual_inspection","scope":"existing_3_frames_per_interval_only","observation":"同源早段为服装正面整体展示，晚段包含近景后转身展示背部，采样中的姿态、景别和展示面不同。","fullVideoReviewed":false,"preferredMvaShotIds":["45a0216cb82a1c121cde529d49efc8e4","ef525191d7d1dedf083e0430309a5c88"],"distinctPairs":[{"shotIds":["45a0216cb82a1c121cde529d49efc8e4","ef525191d7d1dedf083e0430309a5c88"],"visuallyDistinct":true,"evidenceRef":".project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-07.jpg","basis":"non_overlapping_intervals_and_observed_front_vs_back_content"}]}

已审阅 MVA 组合：{"shotIds":["45a0216cb82a1c121cde529d49efc8e4","ef525191d7d1dedf083e0430309a5c88"],"duration":6.4}；CTA 放在该组合末镜，不增加 Shot。

### Case 8: c0f1765d-bf55-41e2-a296-5aababcfe149 / TT2-M1

Eligible=6；Source=2；Old=success；Comparable=true；分类=STRUCTURAL_RULE_TOO_STRICT

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|
| 280078f2127f38d610b6103f06e1c499 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (2).mp4 | 2.42–5.62 | 3.200 | product,end,opening,variation | 0.82/0.4783 | 0.74/0.7175 |
| 506210e34196c56ecb6fa49e12f9be18 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (1).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.96/0.4713 | 0.82/0.7775 |
| 8d4b430ef368296244d886d2d8a4684a | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (2).mp4 | 4.84–8.04 | 3.200 | product,end,opening,variation | 0.78/0.4452 | 0.72/0.7037 |
| 9eaa0c5e73cd218f5a18ecece1e438ef | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (1).mp4 | 4.84–8.04 | 3.200 | product,end,opening,detail | 0.84/0.4674 | 0.88/0.9125 |
| a7b5decdefe5a5fc924208f04ca13198 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (1).mp4 | 2.42–5.62 | 3.200 | product,end,opening,variation | 0.94/0.4438 | 0.84/0.9100 |
| dca1620d0f4e62563c905082696dff49 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (2).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.94/0.4834 | 0.86/0.7937 |

各 Level 的独立失败诊断：

- A: PAIR_CONFLICTS; 需要 5 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- B: PAIR_CONFLICTS; 需要 4 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- C: PAIR_CONFLICTS; 需要 3 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：

- 280078f2127f38d610b6103f06e1c499 + 8d4b430ef368296244d886d2d8a4684a: source_overlap
- 280078f2127f38d610b6103f06e1c499 + dca1620d0f4e62563c905082696dff49: source_overlap
- 506210e34196c56ecb6fa49e12f9be18 + 9eaa0c5e73cd218f5a18ecece1e438ef: same_source_visual_difference_unverified
- 506210e34196c56ecb6fa49e12f9be18 + a7b5decdefe5a5fc924208f04ca13198: source_overlap
- 8d4b430ef368296244d886d2d8a4684a + dca1620d0f4e62563c905082696dff49: same_source_visual_difference_unverified
- 9eaa0c5e73cd218f5a18ecece1e438ef + a7b5decdefe5a5fc924208f04ca13198: source_overlap

仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=true, C=true。此项不是视觉验收通过。

只改 MVA：{"shotIds":["280078f2127f38d610b6103f06e1c499","506210e34196c56ecb6fa49e12f9be18"],"duration":6.4}；MVA + 已审阅差异证据：{"shotIds":["280078f2127f38d610b6103f06e1c499","506210e34196c56ecb6fa49e12f9be18"],"duration":6.4}；仅时间不重叠的条件上限：{"shotIds":["280078f2127f38d610b6103f06e1c499","506210e34196c56ecb6fa49e12f9be18"],"duration":6.4}。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

视觉审计：{"batchId":"c0f1765d-bf55-41e2-a296-5aababcfe149","productId":"TT2-M1","inputHash":"fe85d851d43f91fe370a8ed3ff43be9c929703b8b3ea37065cbe78e624ad80f5","reviewer":"assistant_visual_inspection","scope":"existing_3_frames_per_interval_only","observation":"同源早段为服装正面整体展示，晚段包含近景后转身展示背部，采样中的姿态、景别和展示面不同。","fullVideoReviewed":false,"preferredMvaShotIds":["506210e34196c56ecb6fa49e12f9be18","9eaa0c5e73cd218f5a18ecece1e438ef"],"distinctPairs":[{"shotIds":["506210e34196c56ecb6fa49e12f9be18","9eaa0c5e73cd218f5a18ecece1e438ef"],"visuallyDistinct":true,"evidenceRef":".project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-08.jpg","basis":"non_overlapping_intervals_and_observed_front_vs_back_content"}]}

已审阅 MVA 组合：{"shotIds":["506210e34196c56ecb6fa49e12f9be18","9eaa0c5e73cd218f5a18ecece1e438ef"],"duration":6.3999999999999995}；CTA 放在该组合末镜，不增加 Shot。

### Case 9: d493c143-83f6-4424-b87b-08af45332e33 / TT1-M1

Eligible=6；Source=2；Old=success；Comparable=true；分类=STRUCTURAL_RULE_TOO_STRICT

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|
| 09c829e23757d9bfc96cb035f12dc601 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (1).mp4 | 2.4–5.6 | 3.200 | product,end,opening,variation | 0.84/0.3938 | 0.68/0.6900 |
| 41712842360327dd0972b96475f332e9 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (2).mp4 | 2.42–5.62 | 3.200 | product,end,opening | 0.98/0.4553 | 0.72/0.7300 |
| 45a0216cb82a1c121cde529d49efc8e4 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (1).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.91/0.4447 | 0.82/0.7687 |
| 7f4727e9bae3cf7e314b74fe1e5488f6 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (2).mp4 | 4.84–8.04 | 3.200 | product,end,opening | 0.94/0.4308 | 0.78/0.7538 |
| a063619a3db5d7b4ce26fb746727bb9f | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (2).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.96/0.4765 | 0.84/0.7875 |
| ef525191d7d1dedf083e0430309a5c88 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (1).mp4 | 4.8–8 | 3.200 | product,end,opening,detail | 0.96/0.4339 | 0.78/0.7575 |

各 Level 的独立失败诊断：

- A: PAIR_CONFLICTS; 需要 5 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- B: PAIR_CONFLICTS; 需要 4 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- C: PAIR_CONFLICTS; 需要 3 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：

- 09c829e23757d9bfc96cb035f12dc601 + 45a0216cb82a1c121cde529d49efc8e4: source_overlap
- 09c829e23757d9bfc96cb035f12dc601 + ef525191d7d1dedf083e0430309a5c88: source_overlap
- 41712842360327dd0972b96475f332e9 + 7f4727e9bae3cf7e314b74fe1e5488f6: source_overlap
- 41712842360327dd0972b96475f332e9 + a063619a3db5d7b4ce26fb746727bb9f: source_overlap
- 45a0216cb82a1c121cde529d49efc8e4 + ef525191d7d1dedf083e0430309a5c88: same_source_visual_difference_unverified
- 7f4727e9bae3cf7e314b74fe1e5488f6 + a063619a3db5d7b4ce26fb746727bb9f: same_source_visual_difference_unverified

仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=true, C=true。此项不是视觉验收通过。

只改 MVA：{"shotIds":["09c829e23757d9bfc96cb035f12dc601","41712842360327dd0972b96475f332e9"],"duration":6.4}；MVA + 已审阅差异证据：{"shotIds":["09c829e23757d9bfc96cb035f12dc601","41712842360327dd0972b96475f332e9"],"duration":6.4}；仅时间不重叠的条件上限：{"shotIds":["09c829e23757d9bfc96cb035f12dc601","41712842360327dd0972b96475f332e9"],"duration":6.4}。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

视觉审计：{"batchId":"d493c143-83f6-4424-b87b-08af45332e33","productId":"TT1-M1","inputHash":"5fb2434803d2356b926f8828cd5e29e7ed81cf7213475211daea1ec57b1b26e4","reviewer":"assistant_visual_inspection","scope":"existing_3_frames_per_interval_only","observation":"同源早段为服装正面整体展示，晚段包含近景后转身展示背部，采样中的姿态、景别和展示面不同。","fullVideoReviewed":false,"preferredMvaShotIds":["45a0216cb82a1c121cde529d49efc8e4","ef525191d7d1dedf083e0430309a5c88"],"distinctPairs":[{"shotIds":["45a0216cb82a1c121cde529d49efc8e4","ef525191d7d1dedf083e0430309a5c88"],"visuallyDistinct":true,"evidenceRef":".project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-09.jpg","basis":"non_overlapping_intervals_and_observed_front_vs_back_content"}]}

已审阅 MVA 组合：{"shotIds":["45a0216cb82a1c121cde529d49efc8e4","ef525191d7d1dedf083e0430309a5c88"],"duration":6.4}；CTA 放在该组合末镜，不增加 Shot。

### Case 10: d493c143-83f6-4424-b87b-08af45332e33 / TT2-M1

Eligible=6；Source=2；Old=success；Comparable=true；分类=STRUCTURAL_RULE_TOO_STRICT

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|
| 280078f2127f38d610b6103f06e1c499 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (2).mp4 | 2.42–5.62 | 3.200 | product,end,opening,variation | 0.88/0.4783 | 0.72/0.7175 |
| 506210e34196c56ecb6fa49e12f9be18 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (1).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.96/0.4713 | 0.78/0.7538 |
| 8d4b430ef368296244d886d2d8a4684a | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (2).mp4 | 4.84–8.04 | 3.200 | product,end,opening | 0.96/0.4452 | 0.72/0.7275 |
| 9eaa0c5e73cd218f5a18ecece1e438ef | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (1).mp4 | 4.84–8.04 | 3.200 | product,end,opening,detail | 0.78/0.4674 | 0.88/0.9025 |
| a7b5decdefe5a5fc924208f04ca13198 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (1).mp4 | 2.42–5.62 | 3.200 | product,end,opening | 0.94/0.4438 | 0.86/0.9200 |
| dca1620d0f4e62563c905082696dff49 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT2-M1 (2).mp4 | 0–3.2 | 3.200 | product,end,opening,variation | 0.95/0.4834 | 0.86/0.7962 |

各 Level 的独立失败诊断：

- A: PAIR_CONFLICTS; 需要 5 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- B: PAIR_CONFLICTS; 需要 4 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。
- C: PAIR_CONFLICTS; 需要 3 区间，最多兼容 2（这些区间共 6.400s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：

- 280078f2127f38d610b6103f06e1c499 + 8d4b430ef368296244d886d2d8a4684a: source_overlap
- 280078f2127f38d610b6103f06e1c499 + dca1620d0f4e62563c905082696dff49: source_overlap
- 506210e34196c56ecb6fa49e12f9be18 + 9eaa0c5e73cd218f5a18ecece1e438ef: same_source_visual_difference_unverified
- 506210e34196c56ecb6fa49e12f9be18 + a7b5decdefe5a5fc924208f04ca13198: source_overlap
- 8d4b430ef368296244d886d2d8a4684a + dca1620d0f4e62563c905082696dff49: same_source_visual_difference_unverified
- 9eaa0c5e73cd218f5a18ecece1e438ef + a7b5decdefe5a5fc924208f04ca13198: source_overlap

仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=true, C=true。此项不是视觉验收通过。

只改 MVA：{"shotIds":["280078f2127f38d610b6103f06e1c499","506210e34196c56ecb6fa49e12f9be18"],"duration":6.4}；MVA + 已审阅差异证据：{"shotIds":["280078f2127f38d610b6103f06e1c499","506210e34196c56ecb6fa49e12f9be18"],"duration":6.4}；仅时间不重叠的条件上限：{"shotIds":["280078f2127f38d610b6103f06e1c499","506210e34196c56ecb6fa49e12f9be18"],"duration":6.4}。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

视觉审计：{"batchId":"d493c143-83f6-4424-b87b-08af45332e33","productId":"TT2-M1","inputHash":"fe85d851d43f91fe370a8ed3ff43be9c929703b8b3ea37065cbe78e624ad80f5","reviewer":"assistant_visual_inspection","scope":"existing_3_frames_per_interval_only","observation":"同源早段为服装正面整体展示，晚段包含近景后转身展示背部，采样中的姿态、景别和展示面不同。","fullVideoReviewed":false,"preferredMvaShotIds":["506210e34196c56ecb6fa49e12f9be18","9eaa0c5e73cd218f5a18ecece1e438ef"],"distinctPairs":[{"shotIds":["506210e34196c56ecb6fa49e12f9be18","9eaa0c5e73cd218f5a18ecece1e438ef"],"visuallyDistinct":true,"evidenceRef":".project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-10.jpg","basis":"non_overlapping_intervals_and_observed_front_vs_back_content"}]}

已审阅 MVA 组合：{"shotIds":["506210e34196c56ecb6fa49e12f9be18","9eaa0c5e73cd218f5a18ecece1e438ef"],"duration":6.3999999999999995}；CTA 放在该组合末镜，不增加 Shot。

### Case 11: e50e054b-8741-4be8-a4b7-83e07bea8c38 / gc1-m2

Eligible=0；Source=0；Old=failed；Comparable=false；分类=UPSTREAM_NO_ELIGIBLE_MATERIAL_NOT_SCHEDULER

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|

没有 Eligible Shot；上游导入记录：

- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (1).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (2).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (3).mp4: reject, tech:duration_invalid

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- C: ELIGIBLE_INTERVAL_COUNT; 需要 3 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：


仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：null；仅时间不重叠的条件上限：null。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

### Case 12: f84691f5-aa30-4eb9-9bca-55278665773c / gc1-m2

Eligible=0；Source=0；Old=failed；Comparable=false；分类=UPSTREAM_NO_ELIGIBLE_MATERIAL_NOT_SCHEDULER

| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |
|---|---|---|---:|---|---|---|

没有 Eligible Shot；上游导入记录：

- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (1).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (2).mp4: reject, tech:duration_invalid
- \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m2 (3).mp4: reject, tech:duration_invalid

各 Level 的独立失败诊断：

- A: ELIGIBLE_INTERVAL_COUNT; 需要 5 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- B: ELIGIBLE_INTERVAL_COUNT; 需要 4 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。
- C: ELIGIBLE_INTERVAL_COUNT; 需要 3 区间，最多兼容 0（这些区间共 0.000s），满足所需数量的组合 0。

被成对冲突规则排除的组合（并非删除单个 Shot）：


仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：A=false, B=false, C=false。此项不是视觉验收通过。

只改 MVA：null；MVA + 已审阅差异证据：null；仅时间不重叠的条件上限：null。

Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。

## 证据限制

同 Source 不等于重复。时间不重叠也不自动证明内容不同。可视化使用已有采样帧，无 Provider 调用；完整视频未逐帧复核时，不能将采样差异声明为全片去重验收。具体条件性与已审阅差异见各 Case。

所有原始输入与受保护代码/配置均完成哈希复核。详细机器数据及选中组合见 audit.json。
