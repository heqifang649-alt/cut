import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

// Browser-originated NAS operations are deliberately confined to this single
// share. The UI may choose one immediate child as a batch, but never submit an
// arbitrary UNC path or scan the share root itself.
export const NAS_BATCH_ROOT = String.raw`\\192.168.120.60\新成片交付\批量剪辑素材`;

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mxf", ".mts", ".m2ts", ".avi", ".webm"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"]);
const MAX_FILES = 5000;

export type NasVideo = {
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
};

export type NasScanResult = {
  rootPath: string;
  fileCount: number;
  totalSize: number;
  imageCount: number;
  imageTotalSize: number;
  scannedAt: string;
  speedMBps?: number;
  files: NasVideo[];
  images: NasVideo[];
};

export type NasDirectory = {
  name: string;
  path: string;
};

const normalizedBatchRoot = () => path.win32.normalize(NAS_BATCH_ROOT).replace(/[\\/]+$/, "");

export function allowedNasRoots() {
  // Do not use an environment override here: expanding this list makes the
  // browser flow capable of accidentally scanning an entire share again.
  return [normalizedBatchRoot()];
}

export function validateNasPath(input: string) {
  if (!input?.trim()) throw new Error("请输入 NAS 目录路径");
  const candidate = path.win32.normalize(input.trim().replace(/^['"]|['"]$/g, ""));
  if (!path.win32.isAbsolute(candidate)) throw new Error("NAS 路径必须是完整的 UNC 路径");

  const root = normalizedBatchRoot();
  const rootLower = root.toLocaleLowerCase("zh-CN");
  const candidateLower = candidate.toLocaleLowerCase("zh-CN");
  if (!candidateLower.startsWith(`${rootLower}\\`)) {
    throw new Error("只能选择指定 NAS 素材根目录下的批次文件夹");
  }

  const relative = path.win32.relative(root, candidate);
  // A scan starts only from a folder no deeper than two levels below the
  // approved root: e.g. `TT\\20260820`. The root itself is never scannable.
  const segments = relative.split("\\").filter(Boolean);
  if (!segments.length || segments.length > 2 || relative === ".." || path.win32.isAbsolute(relative)) {
    throw new Error("请从指定 NAS 素材根目录中选择一级或二级批次文件夹");
  }
  return candidate;
}

export async function listNasBatchDirectories(parentPath?: string): Promise<NasDirectory[]> {
  const rootPath = normalizedBatchRoot();
  const directoryPath = parentPath ? path.win32.normalize(parentPath) : rootPath;
  if (parentPath) {
    const relative = path.win32.relative(rootPath, directoryPath);
    const segments = relative.split("\\").filter(Boolean);
    if (segments.length !== 1) throw new Error("只能读取指定 NAS 根目录下的一级文件夹");
  }
  const rootInfo = await stat(directoryPath).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error("NAS 素材根目录无法访问，请确认共享权限");
  const entries = await readdir(directoryPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.win32.join(directoryPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

async function measureReadSpeed(filePath: string, fileSize: number) {
  const bytesToRead = Math.min(fileSize, 8 * 1024 * 1024);
  if (!bytesToRead) return undefined;
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(bytesToRead);
  const started = performance.now();
  try {
    await handle.read(buffer, 0, bytesToRead, 0);
  } finally {
    await handle.close();
  }
  const seconds = Math.max((performance.now() - started) / 1000, 0.001);
  return Math.round((bytesToRead / 1024 / 1024 / seconds) * 10) / 10;
}

export async function scanNasVideos(input: string): Promise<NasScanResult> {
  const rootPath = validateNasPath(input);
  const rootInfo = await stat(rootPath).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error("NAS 目录无法访问，请确认路径和共享权限");

  const files: NasVideo[] = [];
  const images: NasVideo[] = [];
  const pending = [rootPath];
  let totalSize = 0;
  let imageTotalSize = 0;

  while (pending.length) {
    const directory = pending.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.win32.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension) && !IMAGE_EXTENSIONS.has(extension)) continue;
      if (files.length + images.length >= MAX_FILES) throw new Error(`单次最多扫描 ${MAX_FILES} 个媒体文件，请缩小目录范围`);
      const info = await stat(fullPath);
      const relativePath = path.win32.relative(rootPath, fullPath);
      if (VIDEO_EXTENSIONS.has(extension)) {
        files.push({ name: entry.name, relativePath, absolutePath: fullPath, size: info.size });
        totalSize += info.size;
      } else {
        images.push({ name: entry.name, relativePath, absolutePath: fullPath, size: info.size });
        imageTotalSize += info.size;
      }
    }
  }

  if (!files.length) throw new Error("该目录及子目录中没有识别到视频文件");
  const speedMBps = await measureReadSpeed(files[0].absolutePath, files[0].size).catch(() => undefined);
  return { rootPath, fileCount: files.length, totalSize, imageCount: images.length, imageTotalSize, scannedAt: new Date().toISOString(), speedMBps, files, images };
}
