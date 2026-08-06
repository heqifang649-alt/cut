export type BatchStatus =
  | "uploading"
  | "reference_queued"
  | "analyzing_reference"
  | "creating_proxies"
  | "detecting_products"
  | "regroup_queued"
  | "reference_ready"
  | "batch_queued"
  | "editing"
  | "review"
  | "revision_queued"
  | "revising"
  | "cancel_requested"
  | "canceled"
  | "completed"
  | "failed";

export type BatchFile = {
  id: string;
  kind: "reference" | "products" | "product_refs" | "lut" | "hooks" | "bgm" | "output";
  name: string;
  relativePath: string;
  storagePath: string;
  sourceType?: "upload" | "nas";
  absolutePath?: string;
  proxyPath?: string;
  size: number;
  createdAt: string;
  musicName?: string;
  beatOffsetSeconds?: number;
  qualityStatus?: "passed" | "failed";
  productId?: string;
  displayName?: string;
  variantIndex?: number;
  chatcut?: {
    status: "pending" | "syncing" | "ready" | "needs_auth" | "failed";
    manifestPath?: string;
    projectId?: string;
    editorUrl?: string;
    syncedAt?: string;
    error?: string;
    lastActivityAt?: string;
    recoveryAttempts?: number;
  };
};

export type ReferenceProfile = {
  summary: string;
  duration_seconds: number;
  aspect_ratio: string;
  pace: string;
  color: string;
  hook_style: string;
  caption_safe_zone: string;
  cvr_style: string;
  audio_style: string;
  fixed_rules: string[];
  structure: Array<{ timeline: string; purpose: string; shot_type: string; weight: number }>;
  confidence: number;
};

export type ProductGroup = {
  id: string;
  label: string;
  signature: string;
  confidence: number;
  files: string[];
  notes: string;
};

export type ProductDetection = {
  summary: string;
  groups: ProductGroup[];
  unassigned: string[];
  confidence: number;
};

export type NasScan = {
  rootPath: string;
  fileCount: number;
  totalSize: number;
  imageCount?: number;
  imageTotalSize?: number;
  scannedAt: string;
  speedMBps?: number;
};

export type TemplateStatus = "uploading" | "queued" | "analyzing" | "ready" | "failed";

export type SampleTemplate = {
  id: string;
  name: string;
  status: TemplateStatus;
  progress: number;
  file?: BatchFile;
  profile?: ReferenceProfile;
  threadId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  lastWorkerActivityAt?: string;
  recoveryAttempts?: number;
};

export type Batch = {
  id: string;
  name: string;
  requirements: string;
  durationMax: number;
  outputCount: number;
  cvrText: string;
  speed: number;
  autoDetectProducts: boolean;
  sourceMode?: "upload" | "nas";
  nasPath?: string;
  nasScan?: NasScan;
  templateId?: string;
  templateName?: string;
  status: BatchStatus;
  progress: number;
  files: BatchFile[];
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  referenceProfile?: ReferenceProfile;
  productDetection?: ProductDetection;
  commands: Array<{ text: string; createdAt: string }>;
  groupCommands: Array<{ text: string; createdAt: string }>;
  error?: string;
  renderingLabel?: string;
  lastWorkerActivityAt?: string;
  recoveryAttempts?: number;
  delivery?: {
    status: "pending" | "copying" | "delivered" | "failed";
    path?: string;
    error?: string;
    lastActivityAt?: string;
  };
  renderSummary?: {
    renderedProducts: number;
    excludedProducts: Array<{ product_id: string; reason: string }>;
    qualityGates: Record<string, string>;
  };
};
