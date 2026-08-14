export const SEMANTIC_SHOT_SCHEMA_VERSION = "semantic-shot.v1";

const SHOT_TYPES = new Set(["front_full_body", "back_full_body", "detail", "overall", "other"]);
const REQUIRED_FIELDS = [
  "schema_version",
  "shot_id",
  "shot_type",
  "product_match",
  "clothing_visibility",
  "visual_quality",
  "hook_value",
  "usable",
  "confidence",
];

function score(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${field} must be a number between 0 and 1.`);
  return Number(value);
}

export function semanticShotJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: REQUIRED_FIELDS,
    properties: {
      schema_version: { const: SEMANTIC_SHOT_SCHEMA_VERSION },
      shot_id: { type: "string", minLength: 1, maxLength: 160 },
      shot_type: { enum: [...SHOT_TYPES] },
      product_match: { type: "number", minimum: 0, maximum: 1 },
      clothing_visibility: { type: "number", minimum: 0, maximum: 1 },
      visual_quality: { type: "number", minimum: 0, maximum: 1 },
      hook_value: { type: "number", minimum: 0, maximum: 1 },
      usable: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

export function validateSemanticShot(value, { expectedShotId } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Semantic result must be an object.");
  const keys = Object.keys(value).sort();
  if (keys.length !== REQUIRED_FIELDS.length || keys.some((key) => !REQUIRED_FIELDS.includes(key))) {
    throw new TypeError("Semantic result does not match the frozen semantic-shot.v1 schema.");
  }
  if (value.schema_version !== SEMANTIC_SHOT_SCHEMA_VERSION) throw new TypeError("Semantic schema version is invalid.");
  const shotId = typeof value.shot_id === "string" ? value.shot_id.trim() : "";
  if (!shotId || shotId.length > 160 || expectedShotId && shotId !== expectedShotId) throw new TypeError("Semantic shot_id is invalid.");
  if (!SHOT_TYPES.has(value.shot_type)) throw new TypeError("Semantic shot_type is invalid.");
  if (typeof value.usable !== "boolean") throw new TypeError("Semantic usable must be boolean.");
  return Object.freeze({
    schema_version: SEMANTIC_SHOT_SCHEMA_VERSION,
    shot_id: shotId,
    shot_type: value.shot_type,
    product_match: score(value.product_match, "product_match"),
    clothing_visibility: score(value.clothing_visibility, "clothing_visibility"),
    visual_quality: score(value.visual_quality, "visual_quality"),
    hook_value: score(value.hook_value, "hook_value"),
    usable: value.usable,
    confidence: score(value.confidence, "confidence"),
  });
}

export function parseSemanticShot(value, options) {
  if (typeof value !== "string") throw new TypeError("Semantic provider output must be JSON text.");
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new TypeError("Semantic provider output is not valid JSON."); }
  return validateSemanticShot(parsed, options);
}
