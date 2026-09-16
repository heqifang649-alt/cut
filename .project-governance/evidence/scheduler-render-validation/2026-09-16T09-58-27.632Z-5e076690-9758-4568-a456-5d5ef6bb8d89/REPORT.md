# Scheduler V2 MP4 Render Validation

隔离渲染；生产默认旧版，Provider 调用 0。

{
  "renderSuccessRate": 1,
  "planned": 6,
  "rendered": 6,
  "humanReviewed": 0,
  "humanPassRate": null,
  "nearDuplicateRate": null,
  "sameSourceReusePassRate": null,
  "revisionRate": null,
  "note": "Human metrics require submitted human review; null means pending, not zero."
}

## RV1 — A / gc3-m1

- Batch: 0c8c23d7-69fc-42af-a93d-5a1b3103ec1f
- Render: success
- 实测时长: 10.5s
- [MP4](RV1/output/gc3-m1.mp4)
- 同源复用对: 0
- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）

| 顺序 | Shot | Source | 时间区间 |
|---:|---|---|---|
| 1 | 79ed4fadac7b07e81e1cc0db373f079d | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc3-m1 (5).mp4 | 4.42–6.5144 |
| 2 | 8f8e6e3e923cb14d0a243da03571e429 | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc3-m1 (4).mp4 | 4.42–6.5144 |
| 3 | facc336ef19be14d6525b87a89dac2f3 | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc3-m1 (1).mp4 | 4.42–6.5144 |
| 4 | 6c1fa6ecc775570f8dd81778d582dc06 | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc3-m1 (2).mp4 | 0–2.0943999999999994 |
| 5 | b5bc8c02b319dc299fbcfaa36de85034 | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc3-m1 (3).mp4 | 4.42–6.514399999999999 |

## RV2 — B / gc1-m1

- Batch: 0c8c23d7-69fc-42af-a93d-5a1b3103ec1f
- Render: success
- 实测时长: 10.5s
- [MP4](RV2/output/gc1-m1.mp4)
- 同源复用对: 0
- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）

| 顺序 | Shot | Source | 时间区间 |
|---:|---|---|---|
| 1 | a914125105f12a4fa570c86ae150ae95 | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m1.mp4 | 4.42–7.038 |
| 2 | 90066d2ee90aa04e6461b9f33460447c | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m1 (1).mp4 | 4.42–7.037999999999999 |
| 3 | de7d5dafcaf9fd9cbe8099b2f7b9545b | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m1 (3).mp4 | 0–2.6179999999999994 |
| 4 | a29b7de3a48674a77672b4ca04a0e52a | \\192.168.120.60\新成片交付\批量剪辑素材\GC\新建文件夹\gc1-m1 (2).mp4 | 8.84–11.458 |

## RV3 — MVA / TT1-M1

- Batch: c0f1765d-bf55-41e2-a296-5aababcfe149
- Render: success
- 实测时长: 6.4s
- [MP4](RV3/output/TT1-M1.mp4)
- 同源复用对: 0
- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）

| 顺序 | Shot | Source | 时间区间 |
|---:|---|---|---|
| 1 | 45a0216cb82a1c121cde529d49efc8e4 | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (1).mp4 | 0–3.2 |
| 2 | a063619a3db5d7b4ce26fb746727bb9f | \\192.168.120.60\新成片交付\批量剪辑素材\TT\8.28\TT1-M1 (2).mp4 | 0–3.2 |

## RV4 — MVA / 2

- Batch: 1315a6e8-d78a-4c79-904b-731c42b59c1c
- Render: success
- 实测时长: 6.4s
- [MP4](RV4/output/2.mp4)
- 同源复用对: 1
- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）

| 顺序 | Shot | Source | 时间区间 |
|---:|---|---|---|
| 1 | ce03992cf37be53c3be5cbd6b78b6ef9 | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\1315a6e8-d78a-4c79-904b-731c42b59c1c\products\2.mp4 | 4.84–8.04 |
| 2 | 65334551ef683a68d8b8c759229ab285 | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\1315a6e8-d78a-4c79-904b-731c42b59c1c\products\2.mp4 | 0–3.2 |

## RV5 — MVA / 1

- Batch: 3a1d6f81-21f4-41b1-a8f8-9ecca662042f
- Render: success
- 实测时长: 5.4s
- [MP4](RV5/output/1.mp4)
- 同源复用对: 1
- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）

| 顺序 | Shot | Source | 时间区间 |
|---:|---|---|---|
| 1 | cb4040b30f18360ba3574010fe4b48bd | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\1.mp4 | 0–2.7 |
| 2 | c26afa226238f422b34797b1cc60a8fd | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\1.mp4 | 4.84–7.54 |

## RV6 — MVA / 2

- Batch: 3a1d6f81-21f4-41b1-a8f8-9ecca662042f
- Render: success
- 实测时长: 5.4s
- [MP4](RV6/output/2.mp4)
- 同源复用对: 1
- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）

| 顺序 | Shot | Source | 时间区间 |
|---:|---|---|---|
| 1 | dc17e99f42717d8afe2fc08e91a82b42 | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\2.mp4 | 4.84–7.54 |
| 2 | 77591af0038853391b6a8b30b1f8194a | D:\自动剪辑网站\storage\users\2de95197-4417-4ab0-8f87-cf8ea2e5171a\batches\3a1d6f81-21f4-41b1-a8f8-9ecca662042f\products\2.mp4 | 0–2.7 |

## 验收状态

人工指标必须基于真实评审提交，尚未评审时为 null；不将解码成功视为人工通过。人工结果提交后另存 human-validation-report.json，保留此初始渲染报告。

## 输入保护

冻结输入、源媒体大小/修改时间及策略/配置/Renderer 哈希检查通过。全局登记文件漂移：[{"file":"data/batches.json","before":"f0ba55cd75c99bfd4f334cba6e983709cda3f7fa58b6f438c6225115ec6eb15c","after":"06f8105ecd198345686f1591b0593c75976b4f872be4512f013513a8509b1f27","disposition":"live_global_registry_changed; validation_runner_has_no_write_path_to_this_file; not_claimed_unchanged"}]。本验证脚本未写入生产登记文件；不宣称该活动文件未变化。
