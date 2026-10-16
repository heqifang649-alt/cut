# TT10.5 controlled recovery audit — 2026-10-06

Batch `f68d8e1f-4a91-4b13-a92f-34163f57b27f` reached `review` after a scoped semantic recovery. The run is **not** a clean zero-intervention Canary pass: the semantic stage was manually recovered, and analyze/render leases expired during stage finalization.

The immutable semantic history and current complete projection contain 26/26 scored Shots. An independent post-render invocation of `reviewScheduledProductVisualConsistency` against the persisted `schedule-result.json` and `semantic-evidence.v1.json` returned `passed` for all 12 scheduled slots: 4/4 for each of the three directory-identified products. Minimum product-match values were 0.93, 0.99, and 0.97; no visual-gate failure was returned. This was a **retrospective check**, not the gate run recorded in the original render summary, which truthfully says `not_run` because the render caller omitted semantic evidence. Commit `1cc0441` fixes that omission for future runs and requires complete semantic evidence before Hybrid render.

Three output files exist and were decoded by ffprobe at 8.97 seconds each. Their byte counts and SHA-256 prefixes are:

| Product-directory output | Bytes | SHA-256 prefix |
| --- | ---: | --- |
| 新建文件夹.mp4 | 10,535,250 | D960CC520CEF59E6 |
| 新建文件夹 (2).mp4 | 10,852,527 | 09D826A5B6244EFD |
| 新建文件夹 (3).mp4 | 10,656,555 | 97F30602895353E6 |

This audit does not substitute for human visual acceptance or a new clean multi-Batch Canary. No historical evidence was deleted or rewritten.
