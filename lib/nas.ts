import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_NAS_ROOTS = [
  String.raw`\\192.168.120.60\内容创意部-fb广告成片交付`,
  String.raw`\\192.168.120.60\新成片交付`,
].join(";");
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

export function allowedNasRoots() {
  const configured = process.env.ALLOWED_NAS_ROOTS || DEFAULT_NAS_ROOTS;
  return configured.split(";").map((item) => path.win32.normalize(item.trim())).filter(Boolean);
}

export function validateNasPath(input: string) {
  if (!input?.trim()) throw new Error("请输入 NAS 目录路径");
  const candidate = path.win32.normalize(input.trim().replace(/^['"]|['"]$/g, ""));
  if (!path.win32.isAbsolute(candidate)) throw new Error("NAS 路径必须是完整的 UNC 路径");
  const lower = candidate.toLocaleLowerCase("zh-CN");
  const allowed = allowedNasRoots().find((root) => {
    const normalizedRoot = root.replace(/[\\/]+$/, "");
    const rootLower = normalizedRoot.toLocaleLowerCase("zh-CN");
    return lower === rootLower || lower.startsWith(`${rootLower}\\`);
  });
  if (!allowed) throw new Error("该目录不在允许读取的 NAS 范围内");
  return candidate;
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
