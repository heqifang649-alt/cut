function baseName(value) {
  return String(value || "").replaceAll("\\", "/").split("/").at(-1) || "";
}

function withoutExtension(value) {
  return baseName(value)
    .replace(/\.[^.]+$/, "")
    // Windows duplicates commonly add " (1)", "(2)" and similar suffixes.
    // Chinese Windows locales may render the marker with full-width
    // parentheses, e.g. `gc1-m1（2）.mp4`.
    // They are file-copy markers, never product or model identifiers.
    .replace(/\s*(?:(?:\(\d+\))|(?:（\d+）))\s*$/, "");
}

function sourcePath(file) {
  return String(file?.relativePath || file?.name || "");
}

function directProductFolder(file) {
  const parts = sourcePath(file)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  // A media item directly in the selected batch directory is not assigned to
  // a product folder. Dot segments are also rejected defensively so only a
  // scanner-produced relative path can qualify for deterministic grouping.
  if (parts.length < 2 || parts.some((part) => part === "." || part === "..")) return null;
  return parts[0];
}

function parseModelToken(parts) {
  const first = parts[1] || "";
  const second = parts[2] || "";
  if (/^model$/i.test(first) && second) return `Model_${second}`;
  if (/^m$/i.test(first) && second) return `M_${second}`;
  // A model marker is deliberately semantic rather than numeric: M1, M2,
  // ModelA and ModelB all work without enumerating the model names.
  if (/^(?:m|model)[a-z0-9-]+$/i.test(first)) return first;
  return null;
}

export function parseFilenameSession(file) {
  const source = file?.relativePath || file?.name || "";
  const parts = withoutExtension(source).split(/[_\s]+/).map((part) => part.trim()).filter(Boolean);
  const product = parts[0] || "";
  // Product numbers are intentionally required to contain a digit. This
  // prevents generic filenames such as "front_detail.mp4" becoming products.
  if (!/^(?=.*\d)[a-z0-9][a-z0-9-]*$/i.test(product)) return null;
  const model = parseModelToken(parts);
  return {
    file: source,
    product,
    productKey: product.toUpperCase(),
    model,
    modelKey: model?.toUpperCase() || null,
  };
}

export function groupProductsByFilename(files) {
  const parsed = [];
  const unassigned = [];
  for (const file of files || []) {
    const session = parseFilenameSession(file);
    if (session) parsed.push(session);
    else unassigned.push(file?.relativePath || file?.name || "");
  }

  const byProduct = new Map();
  for (const entry of parsed) {
    const product = byProduct.get(entry.productKey) || { product: entry.product, entries: [] };
    product.entries.push(entry);
    byProduct.set(entry.productKey, product);
  }

  const groups = [];
  for (const { product, entries } of byProduct.values()) {
    const models = new Map(entries.filter((entry) => entry.modelKey).map((entry) => [entry.modelKey, entry.model]));
    const hasMultipleModels = models.size > 1;
    const sessions = new Map();
    for (const entry of entries) {
      // If one product has multiple named models, a clip lacking the model
      // marker must not be guessed into either Session.
      if (hasMultipleModels && !entry.modelKey) {
        unassigned.push(entry.file);
        continue;
      }
      const id = hasMultipleModels ? `${product}_${entry.model}` : product;
      const key = id.toUpperCase();
      const group = sessions.get(key) || {
        id,
        label: id,
        signature: hasMultipleModels ? `文件名产品编号 ${product}；模特 Session ${entry.model}` : `文件名产品编号 ${product}`,
        confidence: 1,
        files: [],
        notes: hasMultipleModels
          ? "按文件名锁定产品与模特 Session；Scheduler 仅处理此 Session。"
          : "按文件名锁定产品编号；该产品仅识别到一个模特，已合并为产品 Session。",
      };
      group.files.push(entry.file);
      sessions.set(key, group);
    }
    groups.push(...sessions.values());
  }

  groups.sort((left, right) => left.id.localeCompare(right.id));
  return {
    summary: groups.length
      ? `已按文件名优先规则生成 ${groups.length} 个产品 Session。`
      : "未识别到符合产品编号规则的文件名，将交由视觉识别分组。",
    groups,
    unassigned: [...new Set(unassigned.filter(Boolean))],
    confidence: groups.length ? 1 : 0,
  };
}

/**
 * Determine product ownership from the selected batch folder structure.
 *
 * A conforming batch has every video and product image under exactly one
 * immediate child directory and each child with media contains both kinds.
 * This intentionally validates the whole batch: accepting only the good
 * folders would let an unclassified clip silently bypass the human fallback.
 */
export function groupProductsByProductDirectory(videoFiles, productReferenceFiles) {
  const videos = Array.isArray(videoFiles) ? videoFiles : [];
  const references = Array.isArray(productReferenceFiles) ? productReferenceFiles : [];
  const folders = new Map();
  const reasons = [];

  const add = (file, kind) => {
    const folder = directProductFolder(file);
    const filePath = sourcePath(file);
    if (!folder) {
      reasons.push(`${kind === "video" ? "视频" : "产品图"}不在一级产品文件夹中：${filePath || "未命名文件"}`);
      return;
    }
    const key = folder.toLocaleLowerCase("zh-CN");
    const item = folders.get(key) || { folder, videos: [], references: [] };
    item[kind === "video" ? "videos" : "references"].push(filePath);
    folders.set(key, item);
  };

  if (!videos.length) reasons.push("没有可分组的视频素材");
  if (!references.length) reasons.push("没有产品图；不能按产品文件夹自动确认");
  videos.forEach((file) => add(file, "video"));
  references.forEach((file) => add(file, "reference"));

  for (const item of folders.values()) {
    if (!item.videos.length) reasons.push(`产品文件夹缺少视频：${item.folder}`);
    if (!item.references.length) reasons.push(`产品文件夹缺少产品图：${item.folder}`);
  }

  if (reasons.length) {
    return {
      isCompliant: false,
      summary: "素材目录不符合“一个一级文件夹对应一款产品，且同时包含视频和产品图”的规则，已回退到原有分组流程。",
      groups: [],
      unassigned: videos.map(sourcePath).filter(Boolean),
      confidence: 0,
      groupingMethod: "product_directory",
      autoApproved: false,
      reasons: [...new Set(reasons)],
    };
  }

  const groups = [...folders.values()]
    .map((item) => ({
      id: item.folder,
      label: item.folder,
      signature: `产品文件夹：${item.folder}`,
      confidence: 1,
      files: item.videos,
      productReferenceFiles: item.references,
      sourceFolder: item.folder,
      notes: "已由产品文件夹确定性分组；同一一级文件夹内的视频与产品图属于同一款产品。",
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "zh-CN"));

  return {
    isCompliant: true,
    summary: `已按产品文件夹确认 ${groups.length} 款产品，跳过人工分组确认。`,
    groups,
    unassigned: [],
    confidence: 1,
    groupingMethod: "product_directory",
    autoApproved: true,
    reasons: [],
  };
}
