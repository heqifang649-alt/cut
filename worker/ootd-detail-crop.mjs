export function resolveOotdDetailCrop(box) {
  if (!box || !Number.isFinite(box.confidence) || box.confidence < 0.85 || box.confidence > 1) return null;
  const {left,top,right,bottom}=box;
  if (![left,top,right,bottom].every(value=>Number.isFinite(value)&&value>=0&&value<=1)
    || right<=left || bottom<=top) return null;
  const padding=0.06;
  const size=Math.max(0.5,right-left+2*padding,bottom-top+2*padding);
  if(size>0.8 || left<padding || top<padding || right>1-padding || bottom>1-padding) return null;
  const center=(low,high)=>Math.max(0,Math.min(1-size,(low+high-size)/2));
  return {size,x:center(left,right),y:center(top,bottom)};
}
