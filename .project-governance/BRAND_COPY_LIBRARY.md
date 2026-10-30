# Brand Hook / CTA integration v1

This is an opt-in creative enhancement. Scheduler, Quality Gate, provider/model,
concurrency, product grouping, historical batches and production defaults are unchanged.
`ENABLE_BRAND_COPY_LIBRARY` is unset/off by default. Isolated jobs may set
`batch.brandCopyEnabled = true` in their local descriptors; the public create endpoint
does not expose this switch. No production restart/cutover is part of this change.

## Trusted upstream contract

Authenticated `POST /api/batches` accepts optional `brandCopyContext`:

```json
{
  "brandId": "GuidingCross",
  "script": {"hook": "Original script Hook", "cta": "Explore the collection"},
  "locked": {"hook": "An explicitly locked Hook"},
  "products": {
    "product-id": {
      "garment": "hoodie",
      "script": {"hook": "Product-specific original copy"}
    }
  }
}
```

The server stamps `authenticated_api`; callers cannot supply their own trust source.
Hash-verified LibTV and LAN handoffs accept optional `manifest.brand_copy` with the
same fields, or `manifest.source.brand_id` plus `source.ad_script`, and stamp
`verified_handoff`. Existing handoffs require no migration and still work without a
brand. No file/path, batch name, image, or clothing appearance is used to detect brands.

GC / GuidingCross maps to GC. TT / Tokyo-Tiger / TokyoTiger maps to TT.
Unknown/missing brand skips the library. Product-specific explicit brand bindings
override Batch brand only for that product. Existing explicit `hookText` / `cvrText`
retain their locked semantics. Hook and CTA are resolved separately.

## Files and updates

NAS root: `\\192.168.120.60\新成片交付\批量剪辑素材\HOOK文案`.
Built-in historical mappings: GC → `GuidingCross_FB_Hook库.xlsx`; TT → `TT_Hook_CTA.xlsx`.
The 2026-10-21 dynamic registry `config/brand-copy-files.json` maps GC → `基督.xlsx`,
TT → `亚文化.xlsx`, NW → `暗黑.xlsx`, using the explicit user brand mapping recorded
in `artifacts/brand-bgm-20261021/ACCEPTANCE.md`. The first two files have unchanged
workbook hashes. NW uses the existing parser with exact header aliases:
`暗黑标题` → Hook and `暗黑引导语` → CTA. `分类统计` supplies no copy.
`健身.xlsx` is the renamed unchanged fitness workbook and remains unbound.
See `evidence/brand-copy-refresh-20261021/report.json` for the read-only inventory
comparison and targeted checks. No deployment, restart, production opt-in, or default
change was performed; already-running Node processes need to load the updated module
through the normal release lifecycle before the new NW header aliases apply.
`健身hook库.xlsx` has no automatic brand binding. An upstream-authorized
`libraryFiles: ["健身hook库.xlsx"]` explicitly binds it to that upstream brand.

Additional files/brands can be explicitly registered in optional
`config/brand-copy-files.json`, without new matching code:

```json
{"filesByBrand": {"ExplicitBrandId": ["ExplicitBrandId_Hooks.xlsx"]}}
```

The reader uses the Runtime Contract Python executable and standard-library OOXML
parsing. It only opens original workbooks for reading, ignores stale dimensions,
skips formula cells, honors visible worksheets, accepts shared/inline strings, and
records original text, file hash, sheet and physical row. A retired GC
`35-44优先测试` / `35–44优先测试` worksheet is excluded even if present in a stale NAS
copy/cache. No age or sheet-priority weight is used. Duplicates keep provenance but
gain no weight.

New workflows capture `brand-copy-snapshot.v1.json` at their first optional analysis/
quality/edit entry (or render fallback for direct render jobs). Each new Batch reads
the current workbooks with a bounded 2.5-second subprocess budget. Successful reads
replace prior file contents, including removed rows/sheets. NAS/missing/parse errors
use the last valid per-file local cache; absent cache means an empty library. Cache
writes are best effort, with no global lock or fleet wait. A running Batch and all
its render retries use its frozen snapshot. Outputs freeze `selection.json` in an
output-specific directory. Excel updates do not change completed output signatures.

## Selection and rendering

The selector reads only selected EDL shot IDs/tags, exact existing Semantic Evidence,
trusted product fields and the script references to those selected shots. It adds no
Provider calls. Explicit unboxing/training tags can be consumed when present in the
existing structured evidence; absent evidence does not turn a planned scene into an
observed fact. It can fall back to generic compatible text or the script.

Priority: explicit lock → supported current-brand library text → script → compatible
template → no extra caption. Candidate priority never changes a shot, product safety
decision, cut, speed, or output duration. Claims about promotions, counts, materials,
comfort, tests, stock and popularity are conservatively skipped without explicit
trusted evidence; even an unusable locked caption is omitted instead of silently
being replaced by Excel text. The locked original remains in the decision record.

Every actual output/variant independently freezes Hook and CTA, including selected
origins, actual displayed text, absence/fallback reasons, snapshot hash and layout
diagnostics. Existing typography and overlay compositor are reused. Reading-time
limits use the actual first/final shot duration, capped at three seconds. Overlong or
out-of-bounds optional text becomes transparent; no caption extends/duplicates/freezes
footage. If optional typography/sidecar IO fails, composition continues without extra
overlays. An absent CTA does not emit the legacy default best-seller text.

This uses existing layout protection, not a new face/graphic detector. Independent
visual checking remains necessary for arbitrary closeups. No manual-confirmation
step was added to normal Batch execution.

## Validation scope

See `evidence/brand-copy-20261020/REPORT.md` and
`artifacts/brand-copy-20261020/` for the frozen NAS inventory, source/reference hashes,
unit/regression/build logs, four real MP4s and their exact Hook/CTA origins.
Real Canary uses frozen existing safety/semantic evidence, not fresh provider calls;
historical model-comparison evidence is explicitly identified. It is an isolated
subtitle integration check, not a new independent production Quality Gate pass.
