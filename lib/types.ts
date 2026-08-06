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

export const MOTION_ENERGY_VALUES = ["high", "medium", "low"] as const;
export type MotionEnergy = (typeof MOTION_ENERGY_VALUES)[number];

export const REJECT_REASONS = [
  "tech:low_resolution",
  "tech:duration_invalid",
  "tech:low_bitrate",
  "tech:framerate_inconsistent",
  "tech:global_flicker",
  "tech:texture_boil",
  "tech:stutter",
  "motion:warp",
  "motion:non_physical",
  "motion:camera_jump",
  "human:hand_anomaly",
  "human:face_drift",
  "human:limb_mutation",
  "human:body_proportion",
  "human:pose_impossible",
  "human:clothing_fusion",
  "human:eye_anomaly",
  "product:dissolution",
  "product:deformation",
  "product:color_drift",
  "product:logo_inconsistent",
  "product:scale_shift",
  "product:texture_drift",
  "product:bg_fusion",
  "scene:bg_flicker",
  "scene:object_spawn",
  "scene:lighting_shift",
  "scene:text_artifact",
  "review:low_confidence",
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export type Shot = {
  id: string;
  source: string;
  path: string;
  start: number;
  end: number;
  duration: number;
  tags: string[];
  reject: boolean;
  rejectReason?: string;
  origin: "real" | "ai";
  productVisibility?: number;
  productCentered?: boolean;
  motionEnergy?: MotionEnergy;
};

export type Slot = {
  id: string;
  label: string;
  requireTags: string[];
  preferTags?: string[];
  minDuration?: number;
  maxDuration?: number;
  minProductVisibility?: number;
  requireProductCentered?: boolean;
  requireMotionEnergy?: MotionEnergy;
};

export type ScriptTemplate = {
  id: string;
  name: string;
  slots: Slot[];
  totalDuration: number;
  musicBpm?: number;
};

export type ValidationArtifact = {
  type: string;
  confidence: number;
};

export type ValidationResult = {
  verdict: "accept" | "reject" | "review";
  rejectReason?: RejectReason;
  artifacts: ValidationArtifact[];
};

export type RejectBin = {
  videoPath: string;
  rejectReason: RejectReason;
  rejectedAt: string;
  overridden?: boolean;
  overriddenBy?: string;
  overriddenAt?: string;
};

export type MetadataSidecar = {
  video: string;
  tags: string[];
  duration: number;
  platform: string;
  prompt?: string;
};

export type RenderPlan = {
  id: string;
  batchId: string;
  slots: Array<{ slot: Slot; shot: Shot | null }>;
  createdAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonNegativeNumber = (value: unknown): value is number => isNumber(value) && value >= 0;
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => isString(item));
const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";
const isOptionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";
const isOptionalNonNegativeNumber = (value: unknown) => value === undefined || isNonNegativeNumber(value);
const isMotionEnergy = (value: unknown): value is MotionEnergy => MOTION_ENERGY_VALUES.includes(value as MotionEnergy);
const isRejectReason = (value: unknown): value is RejectReason => REJECT_REASONS.includes(value as RejectReason);

export function isShot(value: unknown): value is Shot {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ["id", "source", "path", "start", "end", "duration", "tags", "reject", "rejectReason", "origin", "productVisibility", "productCentered", "motionEnergy"])
    && isString(value.id)
    && isString(value.source)
    && isString(value.path)
    && isNonNegativeNumber(value.start)
    && isNonNegativeNumber(value.end)
    && value.end >= value.start
    && isNonNegativeNumber(value.duration)
    && isStringArray(value.tags)
    && typeof value.reject === "boolean"
    && isOptionalString(value.rejectReason)
    && (value.origin === "real" || value.origin === "ai")
    && isOptionalNonNegativeNumber(value.productVisibility)
    && isOptionalBoolean(value.productCentered)
    && (value.motionEnergy === undefined || isMotionEnergy(value.motionEnergy));
}

export function isSlot(value: unknown): value is Slot {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ["id", "label", "requireTags", "preferTags", "minDuration", "maxDuration", "minProductVisibility", "requireProductCentered", "requireMotionEnergy"])
    && isString(value.id)
    && isString(value.label)
    && isStringArray(value.requireTags)
    && (value.preferTags === undefined || isStringArray(value.preferTags))
    && isOptionalNonNegativeNumber(value.minDuration)
    && isOptionalNonNegativeNumber(value.maxDuration)
    && isOptionalNonNegativeNumber(value.minProductVisibility)
    && isOptionalBoolean(value.requireProductCentered)
    && (value.requireMotionEnergy === undefined || isMotionEnergy(value.requireMotionEnergy));
}

export function isValidationResult(value: unknown): value is ValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ["verdict", "rejectReason", "artifacts"]) || !["accept", "reject", "review"].includes(String(value.verdict))) return false;
  if (value.rejectReason !== undefined && !isRejectReason(value.rejectReason)) return false;
  return Array.isArray(value.artifacts) && value.artifacts.every((artifact) => isRecord(artifact)
    && hasOnlyKeys(artifact, ["type", "confidence"])
    && isString(artifact.type)
    && isNumber(artifact.confidence)
    && artifact.confidence >= 0
    && artifact.confidence <= 1);
}

export function isRejectBin(value: unknown): value is RejectBin {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ["videoPath", "rejectReason", "rejectedAt", "overridden", "overriddenBy", "overriddenAt"])
    && isString(value.videoPath)
    && isRejectReason(value.rejectReason)
    && isString(value.rejectedAt)
    && isOptionalBoolean(value.overridden)
    && isOptionalString(value.overriddenBy)
    && isOptionalString(value.overriddenAt);
}

export function isMetadataSidecar(value: unknown): value is MetadataSidecar {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ["video", "tags", "duration", "platform", "prompt"])
    && isString(value.video)
    && isStringArray(value.tags)
    && isNonNegativeNumber(value.duration)
    && isString(value.platform)
    && isOptionalString(value.prompt);
}

export function isRenderPlan(value: unknown): value is RenderPlan {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "batchId", "slots", "createdAt"]) || !isString(value.id) || !isString(value.batchId) || !isString(value.createdAt) || !Array.isArray(value.slots)) return false;
  return value.slots.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ["slot", "shot"]) && isSlot(entry.slot) && (entry.shot === null || isShot(entry.shot)));
}
