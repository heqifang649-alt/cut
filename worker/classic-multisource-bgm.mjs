import { trustedCopyContext } from '../lib/brand-copy-library.mjs';
import { canonicalBgmBrand } from '../lib/brand-bgm-identity.mjs';

// Called only with the hash-verified handoff record. Never infer a brand from a product name.
export function classicMultisourceBgm(record) {
  const brand = record.sourceBinding?.kind === 'brand' && canonicalBgmBrand(record.sourceBinding.value);
  const reason = !brand ? 'brand_unrecognized' : !record.sources?.length ? 'brand_sources_missing'
    : record.sources.some(source => canonicalBgmBrand(source.brandIdentity) !== brand) ? 'brand_source_mismatch'
    : record.audioPolicy?.bgm && record.audioPolicy.bgm !== 'auto_match' ? 'audio_policy_disabled' : null;
  const resolution = { brand: brand || null, reason, selectionAttempted: false };
  const policy = record.audioPolicy ? { audioPolicy: structuredClone(record.audioPolicy) } : {};
  if (reason) return { brandBgmEnabled: false, brandBgmResolution: resolution,
    ...policy,
    brandBgmContext: {brandId:null, provenance:'verified_handoff'} };
  return { brandBgmEnabled: true, brandBgmResolution: resolution, brandBgmContext: {brandId:brand, provenance:'verified_handoff'},
    ...policy,
    ...(brand === 'NW' ? {brandCopyContext: trustedCopyContext({ brandId: brand }, 'verified_handoff')} : {}) };
}
