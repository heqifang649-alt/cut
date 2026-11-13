import path from 'node:path';
import { readJson, writeJsonAtomic, withFileLock } from './atomic-json.mjs';
import { canonicalBrand } from './brand-copy-library.mjs';

// This policy controls resources only. It never grants execution or changes claims.
export async function classicBrandActivation({ root, context, taskId, manifestSha256, acceptedAt, sources, allocate = true, normalOnly = false }) {
  try {
    const policy = await readJson(path.join(root, 'config/classic-brand-activation.json'), null);
    if (policy?.schemaVersion !== 1 || policy.enabled !== true || !['canary', 'all'].includes(policy.mode)) return null;
    const cutoff = Date.parse(normalOnly ? policy.normalEnabledAfter : policy.enabledAfter), accepted = Date.parse(acceptedAt);
    if (!Number.isFinite(cutoff) || !Number.isFinite(accepted) || accepted <= cutoff) return null;
    const brand = context?.provenance === 'verified_handoff' && canonicalBrand(context.brandId);
    if (!brand || !/^[0-9a-f-]{36}$/i.test(taskId || '') || !/^[0-9a-f]{64}$/i.test(manifestSha256 || '')) return null;
    if (Object.values(context.products || {}).some(p => p.brandId && canonicalBrand(p.brandId) !== brand)) return null;
    if (sources && (!sources.length || sources.some(s => canonicalBrand(s.brandIdentity) !== brand))) return null;
    const copy = await readJson(path.join(root, 'config/brand-copy-files.json'), null);
    const music = await readJson(path.join(root, 'config/brand-bgm-directories.json'), null);
    if (!Array.isArray(copy?.filesByBrand?.[brand]) || !copy.filesByBrand[brand].length || typeof music?.[brand] !== 'string' || !music[brand]) return null;
    const identity = { taskId, manifestSha256, acceptedAt, brand, enabledAfter: normalOnly ? policy.normalEnabledAfter : policy.enabledAfter, ...(normalOnly ? {scope:"normal_gc_tt"} : {}) };
    if (normalOnly) return policy.normalClassicBrandResources === true && ["GC","TT"].includes(brand) ? identity : null;
    const statePath = path.join(root, 'data/classic-brand-activation-state.json');
    const matches = state => state && ['taskId', 'manifestSha256', 'acceptedAt', 'brand', 'enabledAfter'].every(k => state[k] === identity[k]);
    if (policy.mode === 'all') {
      // Expansion requires an explicit operator acceptance record, never auto-promotes.
      if (policy.canaryAccepted !== true || !policy.canaryEvidence) return null;
      return identity;
    }
    if (!allocate) return matches(await readJson(statePath, null)) ? identity : null;
    return await withFileLock(statePath, async () => {
      const state = await readJson(statePath, null);
      if (state) return matches(state) ? identity : null;
      await writeJsonAtomic(statePath, identity);
      return identity;
    });
  } catch {
    // Optional resource activation cannot fail an otherwise valid edit.
    console.warn('CLASSIC_BRAND_ACTIVATION_UNAVAILABLE');
    return null;
  }
}

export async function enableClassicBrandResources(options) {
  const activation = await classicBrandActivation({...options,normalOnly:true,allocate:false}) || await classicBrandActivation(options);
  return activation ? { brandCopyEnabled: true, brandBgmEnabled: true, classicBrandActivation: activation } : {};
}
