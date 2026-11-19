// Music identities are deliberately independent of Hook/CTA activation.
export const BRAND_BGM_DIRECTORIES = Object.freeze({
  NW: '暗黑', IP: '健身', GC: '基督', TT: '亚文化', GK: '极客', TSG: '教师', PPH: '魔法', PW: '泛读书', NS: '护士',
});
const aliases = {nw:'NW',nerdywave:'NW',ip:'IP',ironpandafit:'IP',gc:'GC',guidingcross:'GC',tt:'TT',tokyotiger:'TT',gk:'GK',geeksoutfit:'GK',tsg:'TSG',teachersgram:'TSG',pph:'PPH',purplehecate:'PPH',pw:'PW',pagewings:'PW',ns:'NS',nursehutshop:'NS'};
export function canonicalBgmBrand(value) {
  const key = String(value ?? '').toLowerCase().replace(/[\s_-]/g, '');
  return Object.hasOwn(aliases, key) ? aliases[key] : null;
}
