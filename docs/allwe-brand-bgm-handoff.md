# ALLWE brand BGM handoff

For brand-profile multisource handoffs, send a supported brand key in `sourceBinding.value` and every `sources[].brandIdentity`. TT should send `tokyotiger`; `TT`, `Tokyo-Tiger`, `TokyoTiger` and case/space/hyphen/underscore variants resolve to TT. Values may differ textually only when they resolve to the same canonical brand. Cross-brand values are rejected by admission. Product binding rules are unchanged.

```json
{
  "sourceBinding": {
    "kind": "brand",
    "value": "tokyotiger",
    "businessBrandId": "483d70a2-c291-4102-93e5-734166a8767a",
    "granularity": "brand-profile",
    "productIdProvided": false
  },
  "sources": [{
    "productId": null,
    "brandIdentity": "tokyotiger",
    "businessBrandId": "483d70a2-c291-4102-93e5-734166a8767a"
  }],
  "edit_policy": {
    "audioPolicy": {"sourceAudio": "mute", "bgm": "auto_match", "beatSync": true}
  }
}
```

This excerpt omits the existing required task, source integrity, path, order and policy fields. `businessBrandId` is optional opaque business metadata retained in the binding/source records, never a music lookup key. An upstream root `brandIdentity` UUID can remain business metadata, but it does not replace the required keys above. No UUID-to-brand association is inferred. Brand name, URL and profileId are unnecessary for music selection when these keys are supplied. Upstream must regenerate manifest SHA256/READY/descriptor for future handoffs using the existing contract; never mutate an already accepted package or resubmit a completed task under a different hash.

Supported fixed libraries remain NW=暗黑, IP=健身, GC=基督, TT=亚文化, GK=极客, TSG=教师, PPH=泛读书. No cross-brand fallback is permitted. A recognized, source-consistent brand enables the existing brand-only audio path for `bgm=auto_match`. Legacy handoffs without an audio policy retain existing activation behavior; an explicit other BGM policy disables this automatic selection. Original source audio remains excluded.

The render BGM decision keeps `status=selected|cached|no_bgm` and adds `reason`, `selectionAttempted`, `candidateCount`. Reasons distinguish `brand_unrecognized`, `brand_sources_missing`, `brand_source_mismatch`, `audio_policy_disabled`, `bgm_disabled`, `library_mapping_invalid`, `library_unavailable`, `no_candidate_tracks`, `track_decode_failed`, `track_normalization_failed`. `candidateCount=null` means no successful scan/count; zero is reserved for an actually scanned empty library. Warnings remain available. These details flow through the existing BGM decision in render checkpoints/manifests; no new public completion state or blocking Quality Gate is introduced. A valid silent output can still complete under the existing contract.

This patch does not change templates, shot scheduling, rhythm, Hook/CTA, beat-sync algorithms or Quality Gate rules.
