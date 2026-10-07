// A conservative, versioned decision over structured visual evidence. This
// never substitutes for the downstream Quality Gate or a human review.
export const PRODUCT_AUTO_CONFIRM_POLICY = "visual-reference-v1";

const key = value => String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "").toLocaleLowerCase("zh-CN");
const certain = value => /^(?:none|no uncertainty|无|无不确定性|没有)$/i.test(String(value || "").trim());

export function assessVisualProductAutoConfirmation(detection, videos, references) {
  const hold = reason => ({ eligible: false, reason, policyVersion: PRODUCT_AUTO_CONFIRM_POLICY });
  if (detection?.groupingMethod !== "visual") return hold("仅完整视觉分组可自动确认");
  if (!Array.isArray(videos) || !videos.length || !Array.isArray(references) || !references.length) return hold("缺少视频或真实产品参考图");
  if (!Array.isArray(detection.groups) || !detection.groups.length || !Array.isArray(detection.unassigned) || detection.unassigned.length) return hold("存在未归组素材");
  if (Number(detection.confidence) < 0.95) return hold("整体分组置信度不足");
  const videoKeys = videos.map(file => key(file.relativePath));
  const referenceKeys = references.map(file => key(file.relativePath));
  if (videoKeys.some(value => !value) || new Set(videoKeys).size !== videoKeys.length || referenceKeys.some(value => !value) || new Set(referenceKeys).size !== referenceKeys.length) return hold("输入文件清单不完整或重复");
  const observed = Array.isArray(detection.observations) ? detection.observations : [];
  const observedByFile = new Map(observed.map(item => [key(item.file), item]));
  if (observedByFile.size !== videoKeys.length + referenceKeys.length) return hold("逐文件视觉证据不完整");
  for (const file of [...videos, ...references]) {
    const observation = observedByFile.get(key(file.relativePath));
    const requiredFrames = file.kind === "product_refs" ? 1 : 3;
    if (!observation || observation.reference !== (file.kind === "product_refs") || Number(observation.confidence) < 0.95 || !String(observation.features || "").trim() || !certain(observation.uncertainty)
      || !Array.isArray(observation.frameHashes) || observation.frameHashes.length !== requiredFrames || observation.frameHashes.some(hash => !/^[a-f0-9]{64}$/i.test(hash))) return hold(`逐文件证据不足：${file.relativePath}`);
  }
  const ownedVideos = new Set();
  const ownedReferences = new Set();
  const referenceSet = new Set(referenceKeys);
  const videoSet = new Set(videoKeys);
  const groups = [];
  for (const group of detection.groups) {
    if (!String(group.id || "").trim() || !String(group.signature || "").trim() || Number(group.confidence) < 0.95 || !Array.isArray(group.files) || !group.files.length || !Array.isArray(group.productReferenceFiles) || !group.productReferenceFiles.length) return hold("产品组身份或参考图证据不足");
    for (const file of group.files) {
      const source = key(file);
      if (!videoSet.has(source) || ownedVideos.has(source)) return hold("视频缺失、越界或重复归属");
      ownedVideos.add(source);
    }
    for (const file of group.productReferenceFiles) {
      const source = key(file);
      if (!referenceSet.has(source) || ownedReferences.has(source)) return hold("参考图缺失、越界或跨产品复用");
      ownedReferences.add(source);
    }
    groups.push({ groupId: group.id, videos: [...group.files], references: [...group.productReferenceFiles] });
  }
  if (ownedVideos.size !== videoKeys.length || ownedReferences.size !== referenceKeys.length) return hold("视频或参考图未被完整覆盖");
  return { eligible: true, reason: "逐文件证据明确，产品与参考图唯一且完整覆盖", policyVersion: PRODUCT_AUTO_CONFIRM_POLICY, groups };
}
