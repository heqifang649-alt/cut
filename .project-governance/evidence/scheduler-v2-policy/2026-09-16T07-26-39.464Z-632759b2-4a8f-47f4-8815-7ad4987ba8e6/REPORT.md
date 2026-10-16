# Scheduler V2 正式策略 Shadow 验证

版本：scheduler-v2.0-mva5；生产默认 off，未切换。

{
  "products": 42,
  "oldSuccess": 40,
  "v2Success": 42,
  "oldSuccessToV2Fail": 0,
  "oldFailToV2Success": 2,
  "levels": {
    "A": 6,
    "B": 21,
    "MVA": 15
  },
  "sameSourceReuseProducts": 3,
  "sameSourcePairs": 3,
  "selectedOverlapOrDuplicate": 0,
  "upstreamTechnicalBlocks": 5,
  "providerCalls": 0,
  "renders": 0,
  "originalInputsUnchanged": true
}

| Batch / 产品 | Old | V2 | 实际可剪秒数 | Shots | 同源复用对 |
|---|---|---|---:|---:|---:|
| 1315a6e8 / 2 | success | MVA | 6.400 | 2 | 1 |
| 3a1d6f81 / 1 | failed | MVA | 5.400 | 2 | 1 |
| 3a1d6f81 / 2 | failed | MVA | 5.400 | 2 | 1 |
| 0c8c23d7 / gc1-m1 | success | B | 10.472 | 4 | 0 |
| 0c8c23d7 / gc2-m1 | success | MVA | 6.400 | 2 | 0 |
| 0c8c23d7 / gc3-m1 | success | A | 10.472 | 5 | 0 |
| 12231c97 / TT1 | success | B | 10.472 | 4 | 0 |
| 12231c97 / TT2_M1 | success | B | 10.472 | 4 | 0 |
| 12231c97 / TT2_M2 | success | B | 10.472 | 4 | 0 |
| 1fab1a7f / TT1-M1 | success | B | 10.472 | 4 | 0 |
| 28ccad48 / TT1 | success | B | 10.000 | 4 | 0 |
| 28ccad48 / TT2_M1 | success | B | 10.000 | 4 | 0 |
| 28ccad48 / TT2_M2 | success | B | 10.000 | 4 | 0 |
| 5224e1b5 / TT1-M1 | success | MVA | 6.400 | 2 | 0 |
| 559023a9 / TT1-M1 | success | MVA | 6.400 | 2 | 0 |
| 559023a9 / TT2-M1 | success | B | 10.472 | 4 | 0 |
| 559023a9 / TT3-M1 | success | B | 10.472 | 4 | 0 |
| 559023a9 / TT4-M1 | success | A | 10.472 | 5 | 0 |
| 559023a9 / TT5-M1 | success | B | 10.472 | 4 | 0 |
| 559023a9 / TT5-M2 | success | B | 10.472 | 4 | 0 |
| 559023a9 / TT6-M1 | success | B | 10.472 | 4 | 0 |
| 70e3f544 / gc1-m1 | success | B | 10.472 | 4 | 0 |
| 70e3f544 / gc2-m1 | success | MVA | 6.400 | 2 | 0 |
| 70e3f544 / gc3-m1 | success | A | 10.472 | 5 | 0 |
| 71eeff5a / gc1-m1 | success | MVA | 6.220 | 2 | 0 |
| c0f1765d / TT1-M1 | success | MVA | 6.400 | 2 | 0 |
| c0f1765d / TT2-M1 | success | MVA | 6.400 | 2 | 0 |
| c50a4f78 / GC-20260810-01 | success | A | 10.999 | 5 | 0 |
| d493c143 / TT1-M1 | success | MVA | 6.400 | 2 | 0 |
| d493c143 / TT2-M1 | success | MVA | 6.400 | 2 | 0 |
| e50e054b / gc1-m1 | success | B | 10.472 | 4 | 0 |
| ed5127ed / TT1-M1 | success | MVA | 6.400 | 2 | 0 |
| f25ee21e / P01 | success | A | 10.000 | 5 | 0 |
| f84691f5 / gc1-m1 | success | B | 10.472 | 4 | 0 |
| f84691f5 / gc2-m1 | success | MVA | 6.400 | 2 | 0 |
| f84691f5 / gc3-m1 | success | A | 10.472 | 5 | 0 |
| f1e8578b / TT1-M1 | success | MVA | 6.400 | 2 | 0 |
| f1e8578b / TT2-M1 | success | B | 10.472 | 4 | 0 |
| f1e8578b / TT3-M1 | success | B | 10.472 | 4 | 0 |
| f1e8578b / TT5-M1 | success | B | 10.472 | 4 | 0 |
| f1e8578b / TT5-M2 | success | B | 10.472 | 4 | 0 |
| f1e8578b / TT6-M1 | success | B | 10.472 | 4 | 0 |

## 同源复用实例

- 1315a6e8-d78a-4c79-904b-731c42b59c1c/2: D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\1315a6e8-d78a-4c79-904b-731c42b59c1c\products\2.mp4; [[4.84,8.04],[0,3.2]]; shots=65334551ef683a68d8b8c759229ab285,ce03992cf37be53c3be5cbd6b78b6ef9; evidence=.project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-01.jpg
- 3a1d6f81-21f4-41b1-a8f8-9ecca662042f/1: D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\1.mp4; [[0,2.7],[4.84,7.54]]; shots=cb4040b30f18360ba3574010fe4b48bd,c26afa226238f422b34797b1cc60a8fd; evidence=.project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-02.jpg
- 3a1d6f81-21f4-41b1-a8f8-9ecca662042f/2: D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\2.mp4; [[4.84,7.54],[0,2.7]]; shots=77591af0038853391b6a8b30b1f8194a,dc17e99f42717d8afe2fc08e91a82b42; evidence=.project-governance/evidence/scheduler-comparability/2026-09-16T03-55-33.259Z-cdffe009-6c17-40a7-b40a-4ffa4e7231ea/contact-sheets/case-03.jpg

## 上游技术 Gate

- dba0174c-6ee7-47e5-b356-91633b12d4f9/gc1-m2: UPSTREAM_BLOCKED; 原片时长=15.04,15.04,15.04s；15 秒规则未改。
- 0c8c23d7-69fc-42af-a93d-5a1b3103ec1f/gc1-m2: UPSTREAM_BLOCKED; 原片时长=15.04,15.04,15.04s；15 秒规则未改。
- 70e3f544-c59c-4236-964c-a88ac958bc47/gc1-m2: UPSTREAM_BLOCKED; 原片时长=15.04,15.04,15.04s；15 秒规则未改。
- e50e054b-8741-4be8-a4b7-83e07bea8c38/gc1-m2: UPSTREAM_BLOCKED; 原片时长=15.04,15.04,15.04s；15 秒规则未改。
- f84691f5-aa30-4eb9-9bca-55278665773c/gc1-m2: UPSTREAM_BLOCKED; 原片时长=15.04,15.04,15.04s；15 秒规则未改。

## 保护与限制

选中 overlap/duplicate 冲突为 0；被排除的候选冲突、逐镜来源与时间段保存在 report.json。相同 Source 只有在现有差异证据绑定产品、Shot、区间和帧哈希后才能复用；过期证据不放行。Durations are actual source-cut seconds, not rendered MP4 duration. Visual differences are existing sampled-frame review evidence, not new model inference or complete near-duplicate detection.
