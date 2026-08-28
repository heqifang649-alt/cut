export const QUALITY_EVIDENCE_V2_SCHEMA_VERSION = "quality-evidence.v2";
export const QUALITY_EVIDENCE_V2_PROVIDER_SCHEMA_VERSION = "quality-evidence-provider.v1";
export const QUALITY_EVIDENCE_V2_PROMPT_VERSION = "quality-evidence-v2-prompt.v1";

const VERDICTS = new Set(["accept", "review", "reject"]);
const SEVERITIES = new Set(["none", "suspected", "critical", "unknown"]);
const PRODUCT_RESULTS = new Set(["match", "mismatch", "uncertain"]);
const USABILITY_RESULTS = new Set(["usable", "unusable", "uncertain"]);

function score(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${field} must be a number between 0 and 1`);
  return Number(value);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function severityEvidence(value, field) {
  const input = object(value, field);
  if (!SEVERITIES.has(input.severity)) throw new TypeError(`${field}.severity is invalid`);
  return { severity: input.severity, confidence: score(input.confidence, `${field}.confidence`) };
}

function productEvidence(value) {
  const input = object(value, "product");
  for (const key of ["match", "graphic_text_logo", "color", "structure"]) {
    if (!PRODUCT_RESULTS.has(input[key])) throw new TypeError(`product.${key} is invalid`);
  }
  return {
    match: input.match,
    graphic_text_logo: input.graphic_text_logo,
    color: input.color,
    structure: input.structure,
    confidence: score(input.confidence, "product.confidence"),
  };
}

export function qualityEvidenceProviderJsonSchema() {
  const anomaly = {
    type: "object",
    additionalProperties: false,
    required: ["severity", "confidence"],
    properties: {
      severity: { type: "string", enum: [...SEVERITIES] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "source_id", "artifacts", "product", "usability", "confidence"],
    properties: {
      schema_version: { type: "string", const: QUALITY_EVIDENCE_V2_PROVIDER_SCHEMA_VERSION },
      source_id: { type: "string", minLength: 1, maxLength: 160 },
      artifacts: {
        type: "object",
        additionalProperties: false,
        required: ["hand", "face", "body", "temporal"],
        properties: { hand: anomaly, face: anomaly, body: anomaly, temporal: anomaly },
      },
      product: {
        type: "object",
        additionalProperties: false,
        required: ["match", "graphic_text_logo", "color", "structure", "confidence"],
        properties: {
          match: { type: "string", enum: [...PRODUCT_RESULTS] },
          graphic_text_logo: { type: "string", enum: [...PRODUCT_RESULTS] },
          color: { type: "string", enum: [...PRODUCT_RESULTS] },
          structure: { type: "string", enum: [...PRODUCT_RESULTS] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      usability: { type: "string", enum: [...USABILITY_RESULTS] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

export function parseQualityEvidenceProvider(value, { expectedSourceId } = {}) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const input = object(parsed, "provider evidence");
  if (input.schema_version !== QUALITY_EVIDENCE_V2_PROVIDER_SCHEMA_VERSION) throw new TypeError("Provider evidence schema version is invalid");
  const sourceId = typeof input.source_id === "string" ? input.source_id.trim() : "";
  if (!sourceId || (expectedSourceId && sourceId !== expectedSourceId)) throw new TypeError("Provider evidence source_id is invalid");
  const artifacts = object(input.artifacts, "artifacts");
  return Object.freeze({
    schemaVersion: QUALITY_EVIDENCE_V2_PROVIDER_SCHEMA_VERSION,
    sourceId,
    artifacts: {
      hand: severityEvidence(artifacts.hand, "artifacts.hand"),
      face: severityEvidence(artifacts.face, "artifacts.face"),
      body: severityEvidence(artifacts.body, "artifacts.body"),
      temporal: severityEvidence(artifacts.temporal, "artifacts.temporal"),
    },
    product: productEvidence(input.product),
    usability: USABILITY_RESULTS.has(input.usability) ? input.usability : (() => { throw new TypeError("usability is invalid"); })(),
    confidence: score(input.confidence, "confidence"),
  });
}

function decision(verdict, reason) { return { verdict, reason }; }

export function decideQualityGateV2(evidence, policy) {
  if (evidence?.manualReview?.decision === "reject") return decision("reject", "manual_reject");
  if (evidence?.manualReview?.decision === "accept") return decision("accept", "manual_accept");
  const technicalVerdict = evidence?.technical?.verdict;
  if (technicalVerdict === "reject") return decision("reject", evidence.technical.rejectReason || "technical_reject");
  if (technicalVerdict !== "accept") return decision("review", "technical_not_accepted");
  if (!["complete", "manual_accept"].includes(evidence?.analysisStatus)) return decision("review", evidence?.analysisStatus || "not_run");
  if (evidence.analysisStatus === "manual_accept") return decision("accept", "manual_accept");
  const provider = evidence.providerEvidence;
  if (!provider) return decision("review", "evidence_insufficient");
  if (provider.confidence < Number(policy?.provider?.minimumConfidence || 0.7)) return decision("review", "evidence_insufficient");
  for (const [kind, value] of Object.entries(provider.artifacts || {})) {
    if (value.severity === "critical") return decision("reject", `artifact:${kind}`);
    if (value.severity !== "none") return decision("review", `artifact:${kind}`);
  }
  for (const [field, value] of Object.entries(provider.product || {})) {
    if (field === "confidence") continue;
    if (value === "mismatch") return decision("reject", `product:${field}`);
    if (value !== "match") return decision("review", `product:${field}`);
  }
  if (provider.usability === "unusable") return decision("reject", "usability:unusable");
  if (provider.usability !== "usable") return decision("review", "usability:uncertain");
  return decision("accept", "evidence_complete");
}

export function toValidationResult(evidence) {
  const verdict = evidence?.decision?.verdict;
  if (!VERDICTS.has(verdict)) throw new TypeError("Quality Evidence V2 decision is invalid");
  return verdict === "accept"
    ? { verdict: "accept", artifacts: [] }
    : { verdict, rejectReason: verdict === "review" ? "quality_v2:review" : "quality_v2:reject", artifacts: [] };
}
