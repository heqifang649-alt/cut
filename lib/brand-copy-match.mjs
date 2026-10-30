import { canonicalBrand, copyHash } from './brand-copy-library.mjs';

const trustworthy = c => c && ['authenticated_api','verified_handoff','isolated_canary'].includes(c.provenance);
const scenePatterns={unboxing:/unbox|开箱/i,ootd:/ootd|穿搭|日常|生活方式|自拍|试穿/i,detail:/detail|close.?up|特写|图案|细节/i,training:/workout|gym|training|训练|健身/i,dialogue:/dialogue|对话|双人|双女生/i};
const tagsFor=text=>Object.entries(scenePatterns).filter(([,re])=>re.test(text)).map(([tag])=>tag);
const words=text=>new Set((String(text||'').toLowerCase().match(/[a-z]{4,}/g)||[]).filter(w=>!['this','that','with','your','have','what','just','kind'].includes(w)));

export function selectedCopyContent({product,semanticEvidence,context={}}) {
  const records=new Map((semanticEvidence?.records||[]).map(r=>[r.shotId,r]));
  const clips=(product.segments||[]).map(s=>{
    const record=records.get(s.shot_id);
    const safe=['scored','cache_hit'].includes(record?.status) && record.autoUse!==false && record.wrongSku!==true
      && !['reject','review','wrong_sku'].includes(String(record.verdict||record.decision||'').toLowerCase())
      && record?.result?.usable===true && record.result.product_match>=.5 && record.result.clothing_visibility>=.5;
    const labels=safe ? tagsFor((s.content_tags||[]).join(' ')) : [];
    if(safe&&record.result.shot_type==='detail')labels.push('detail');
    if(safe&&['overall','front_full_body','back_full_body'].includes(record.result.shot_type))labels.push('ootd');
    return {shotId:s.shot_id,tags:[...new Set(labels)],duration:s.duration,sceneEvidence:safe?'existing_semantic_and_tags':'unavailable'};
  });
  const productContext=context.products?.[product.product_id] || {};
  return {clips,tags:[...new Set(clips.flatMap(s=>s.tags))],openingTags:clips[0]?.tags||[],garment:productContext.garment||context.product?.garment||null,
    outfitCount:new Set((product.segments||[]).filter(s=>s.outfit_id).map(s=>s.outfit_id)).size,
    productCount:1,claims:productContext.claims||context.claims||{},script:productContext.script||context.script||{}};
}

export function copyIsSupported(text,content,entry={}) {
  const t=String(text||''), combined=t+' '+(entry.scene||'');
  if(/tokyo[ -]?tiger/i.test(t)&&content.brand!=='TT')return false;
  if(/guiding[ -]?cross/i.test(t)&&content.brand!=='GC')return false;
  const promotion=/\b(sale|discount|prices?|free shipping|save \d+|deals?|offers?|clearance|buy one|get one)\b|\d+\s*%|[$£€]\s*\d+|促销|折扣/i.test(combined);
  if(promotion && !(content.claims.promotion?.verified===true && content.claims.promotion.active===true))return false;
  const percent=t.match(/(\d+)\s*%/);if(percent&&Number(percent[1])!==content.claims.promotion?.percent)return false;
  const price=t.match(/[$£€]\s*(\d+(?:\.\d+)?)/);if(price&&Number(price[1])!==content.claims.promotion?.price)return false;
  if(/buy one|get one|free gift/i.test(t)&&content.claims.promotion?.offerTermsVerified!==true)return false;
  if(/free shipping/i.test(t)&&content.claims.promotion?.freeShipping!==true)return false;
  if(/before.*gone|sell.?s? out|selling out|limited|best.?seller|best selling|most popular|everyone|viral/i.test(t)&&content.claims.stockOrPopularityVerified!==true)return false;
  if(/whole (?:workout|session)|full (?:workout|session)|passed.*test|squat test|survives leg day|one .*session later|trained in|first workout/i.test(t)&&content.claims.trainingTestVerified!==true)return false;
  if(/comfortable|comfier|comfort|breathab|sweat.?proof|water.?proof|squat.?proof|softest|softer|durab|anti.?odor|stretch|cotton|never shrink/i.test(t)&&content.claims.productFeaturesVerified!==true)return false;
  if(/gym guys|for the guys|for men\b/i.test(t)&&content.claims.personaGender!=='male')return false;
  if(/gym girls|for the girls|for women\b/i.test(t)&&content.claims.personaGender!=='female')return false;
  const count=t.match(/\b(\d+)\s+(?:easy\s+)?outfits?\b/i);if(count&&content.outfitCount<Number(count[1]))return false;
  if(/多SKU|multi.?sku|collection montage/i.test(entry.scene||'')&&content.productCount<2)return false;
  const garment=t.match(/\b(tee|t-shirt|jersey|sweater|hoodie|cardigan)\b/i)?.[1]?.toLowerCase();
  if(garment && garment!==String(content.garment||'').toLowerCase())return false;
  return true;
}

const usableText=(text,seconds,kind)=>typeof text==='string'&&text.trim()&&seconds>=.8&&text.length<=Math.min(kind==='hook'?84:64,seconds*21)&&!/[\u2600-\uffff]/.test(text);

export function matchOutputCopy({batch,product,outputId,snapshot,semanticEvidence,templateMaster={}}) {
  const context=trustworthy(batch.brandCopyContext)?batch.brandCopyContext:{};
  const brandId=context.products?.[product.product_id]?.brandId || context.brandId;
  const brand=canonicalBrand(brandId)||brandId||null, content=selectedCopyContent({product,semanticEvidence:semanticEvidence?.batchId===batch.id?semanticEvidence:null,context});
  content.brand=brand;
  const duration=Number(product.duration_seconds)||0;
  const seconds={hook:Math.min(3,Number(product.segments?.[0]?.duration)||duration,duration*.45),cta:Math.min(3,Number(product.segments?.at(-1)?.duration)||duration,duration*.35)};
  const script=content.script;
  const choose=kind=>{
    const legacy=kind==='hook'?batch.hookText:batch.cvrText;
    const scoped=context.products?.[product.product_id];
    const locked=scoped?.locked?.[kind] ?? context.locked?.[kind] ?? (typeof legacy==='string'?legacy:undefined);
    const wrap=(text,source,extra={})=>({text,source,...extra});
    if(typeof locked==='string')return usableText(locked,seconds[kind],kind)&&copyIsSupported(locked,content)?wrap(locked,'locked'):wrap('','none',{reason:'locked_copy_not_displayable_or_unsupported',lockedOriginal:locked});
    const scriptText=typeof script==='string'?null:script?.[kind];
    const affinity=words(typeof script==='string'?script:[scriptText,script?.description,...(script?.shots||[]).filter(s=>content.clips.some(c=>c.shotId===s.shotId)).map(s=>s.description)].filter(Boolean).join(' '));
    const candidates=(snapshot?.entries||[]).filter(e=>e.brand===brand&&e.kind===kind&&usableText(e.text,seconds[kind],kind)&&copyIsSupported(e.text,content,e)).map(e=>{
      const scene=tagsFor(e.scene+' '+e.category), matched=scene.filter(tag=>content.tags.includes(tag));
      if(scene.length&&!matched.length)return null;
      const score=1+matched.length*4+scene.filter(tag=>content.openingTags.includes(tag)).length*3+[...words(e.text)].filter(w=>affinity.has(w)).length;
      return {entry:e,score,key:copyHash(outputId+e.id)};
    }).filter(Boolean).sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key));
    if(candidates.length){const {entry,score}=candidates[0];return wrap(entry.text,'library',{entryId:entry.id,origins:entry.sources,score});}
    if(usableText(scriptText,seconds[kind],kind)&&copyIsSupported(scriptText,content))return wrap(scriptText,'script');
    const template=templateMaster[kind==='hook'?'hook':'cvr']?.text;
    if(usableText(template,seconds[kind],kind)&&copyIsSupported(template,content))return wrap(template,'template');
    return wrap('','none',{reason:'no_supported_displayable_copy'});
  };
  return {version:'output-copy.v1',outputId,productId:product.product_id,brand,snapshotHash:snapshot?.hash||null,content,hook:choose('hook'),cta:choose('cta'),windows:{hookEnd:seconds.hook,ctaStart:Math.max(seconds.hook,duration-seconds.cta)}};
}
