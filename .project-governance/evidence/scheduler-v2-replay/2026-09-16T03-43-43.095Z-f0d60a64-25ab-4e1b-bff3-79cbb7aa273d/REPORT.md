# Scheduler V2 Shadow Replay

Revision: 2026-09-16T03-43-43.095Z-f0d60a64-25ab-4e1b-bff3-79cbb7aa273d

No production writes, Provider calls or rendering. Eligible Shots only; not a complete visual quality gate.

Before: {"products":77,"successCount":47,"scheduleSuccessRate":0.6103896103896104,"noMatchingShotRate":0.38961038961038963,"failureReasons":{"no_matching_shot":30}}

After: {"products":77,"successCount":35,"scheduleSuccessRate":0.45454545454545453,"noMatchingShotRate":0,"failureReasons":{"QUALITY_BLOCKED":9,"INSUFFICIENT_MATERIAL":12,"ANALYSIS_INCOMPLETE":21}}

Historical failures: {"before":{"products":32,"successCount":2,"scheduleSuccessRate":0.0625,"noMatchingShotRate":0.9375,"failureReasons":{"no_matching_shot":30}},"after":{"products":32,"successCount":1,"scheduleSuccessRate":0.03125,"noMatchingShotRate":0,"failureReasons":{"QUALITY_BLOCKED":9,"INSUFFICIENT_MATERIAL":7,"ANALYSIS_INCOMPLETE":15}}}

Duration is planned source-cut duration, not measured MP4 duration. Same-source visual difference must be evidenced; cross-source visual duplicates are unassessed.

| Batch / Product | Before | After level/reason | Cut seconds | Shots | Skipped | Substituted |
|---|---|---|---:|---:|---|---|
| 1315a6e8 / 1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| 1315a6e8 / 2 | success | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| 3a1d6f81 / 1 | failed | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| 3a1d6f81 / 2 | failed | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| dba0174c / gc1-m1 | success | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| dba0174c / gc1-m2 | failed | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| dba0174c / gc2-m1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| dba0174c / gc3-m1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| 0c8c23d7 / gc1-m1 | success | B | 10.472 | 4 | detail |  |
| 0c8c23d7 / gc1-m2 | failed | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| 0c8c23d7 / gc2-m1 | success | C | 9.600 | 3 | detail, variation |  |
| 0c8c23d7 / gc3-m1 | success | A | 10.472 | 5 |  |  |
| 12231c97 / TT1 | success | B | 10.472 | 4 | detail |  |
| 12231c97 / TT2_M1 | success | B | 10.472 | 4 | detail |  |
| 12231c97 / TT2_M2 | success | B | 10.472 | 4 | detail |  |
| 1fab1a7f / TT1-M1 | success | B | 10.472 | 4 | detail |  |
| 28ccad48 / TT1 | success | B | 10.000 | 4 | detail |  |
| 28ccad48 / TT2_M1 | success | B | 10.000 | 4 | detail |  |
| 28ccad48 / TT2_M2 | success | B | 10.000 | 4 | detail |  |
| 5224e1b5 / TT1-M1 | success | C | 9.600 | 3 | detail, variation |  |
| 5224e1b5 / TT2-M1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| 5224e1b5 / TT3-M1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| 5224e1b5 / TT4-M1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| 5224e1b5 / TT5-M1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| 5224e1b5 / TT5-M2 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| 559023a9 / TT1-M1 | success | C | 9.600 | 3 | detail, variation |  |
| 559023a9 / TT2-M1 | success | B | 10.472 | 4 | detail |  |
| 559023a9 / TT3-M1 | success | B | 10.472 | 4 | detail |  |
| 559023a9 / TT4-M1 | success | A | 10.472 | 5 |  |  |
| 559023a9 / TT5-M1 | success | B | 10.472 | 4 | detail |  |
| 559023a9 / TT5-M2 | success | B | 10.472 | 4 | detail |  |
| 559023a9 / TT6-M1 | success | B | 10.472 | 4 | detail |  |
| 6a4cad19 / TT1-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| 6a4cad19 / TT2-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| 6a4cad19 / TT3-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| 6a4cad19 / TT4-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| 6a4cad19 / TT5-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| 6a4cad19 / TT5-M2 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| 70e3f544 / gc1-m1 | success | B | 10.472 | 4 | detail |  |
| 70e3f544 / gc1-m2 | failed | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| 70e3f544 / gc2-m1 | success | C | 9.600 | 3 | detail, variation |  |
| 70e3f544 / gc3-m1 | success | A | 10.472 | 5 |  |  |
| 71eeff5a / gc1-m1 | success | C | 9.420 | 3 | detail, variation |  |
| a56baff1 / GC01-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| a56baff1 / GC01-M2 | success | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| b023d12b / gc1-m1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| b6410096 / GC01-M1 | success | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| b6410096 / GC01-M2 | success | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| c0f1765d / TT1-M1 | success | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| c0f1765d / TT2-M1 | success | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| c50a4f78 / GC-20260810-01 | success | A | 10.999 | 5 |  |  |
| d493c143 / TT1-M1 | success | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| d493c143 / TT2-M1 | success | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| dd50a327 / gc1-m1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| e50e054b / gc1-m1 | success | B | 10.472 | 4 | detail |  |
| e50e054b / gc1-m2 | failed | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| e50e054b / gc2-m1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| e50e054b / gc3-m1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| ed5127ed / TT1-M1 | success | C | 9.600 | 3 | detail, variation |  |
| ed5127ed / TT2-M1 | failed | QUALITY_BLOCKED | 0.000 | 0 |  |  |
| ed5127ed / TT3-M1 | success | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| ed5127ed / TT4-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| ed5127ed / TT5-M1 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| ed5127ed / TT5-M2 | failed | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| f25ee21e / P01 | success | A | 10.000 | 5 |  |  |
| f84691f5 / gc1-m1 | success | B | 10.472 | 4 | detail |  |
| f84691f5 / gc1-m2 | failed | INSUFFICIENT_MATERIAL | 0.000 | 0 |  |  |
| f84691f5 / gc2-m1 | success | C | 9.600 | 3 | detail, variation |  |
| f84691f5 / gc3-m1 | success | A | 10.472 | 5 |  |  |
| 5bb69aa8 / TT1-M1 | success | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| f1e8578b / TT1-M1 | success | C | 9.600 | 3 | detail, variation |  |
| f1e8578b / TT2-M1 | success | B | 10.472 | 4 | detail | variation |
| f1e8578b / TT3-M1 | success | B | 10.472 | 4 | detail |  |
| f1e8578b / TT4-M1 | success | ANALYSIS_INCOMPLETE | 0.000 | 0 |  |  |
| f1e8578b / TT5-M1 | success | B | 10.472 | 4 | detail |  |
| f1e8578b / TT5-M2 | success | B | 10.472 | 4 | detail |  |
| f1e8578b / TT6-M1 | success | B | 10.472 | 4 | detail |  |
