import { decideQualityGateV2 } from "./quality-evidence-v2.mjs";

const result = (state, reason, nextAction) => ({ state, reason, nextAction, sourceHumanApprovalRequired: false });
const score = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
function validAutomaticEvidence(evidence) {
  const p = evidence.providerEvidence;
  return typeof evidence.sourceId === "string" && !!evidence.sourceId && p?.sourceId === evidence.sourceId && ["quality-evidence-provider.v1", "quality-evidence-provider.v2"].includes(p.schemaVersion)
    && score(p.confidence) && ["usable", "unusable", "uncertain"].includes(p.usability)
    && ["hand", "face", "body", "temporal"].every((kind) => ["none", "suspected", "critical", "unknown"].includes(p.artifacts?.[kind]?.severity) && score(p.artifacts[kind].confidence))
    && ["match", "graphic_text_logo", "color", "structure", "wrongSku", "productError"].every((key) => ["match", "mismatch", "uncertain"].includes(p.product?.[key]))
    && score(p.product.confidence);
}

// Human source-approval fields deliberately do not participate. Automatic
// evidence must stand on its own, including when an old manual ACCEPT exists.
export function automaticSourceGate({ sourceHash, references = [], evidence, policy, technicalVerdict } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash || "")) return result("WAITING", "source_hash_unverified", "verify_existing_source_integrity_automatically");
  if (technicalVerdict === "reject" || evidence?.technical?.verdict === "reject") {
    return result("REJECT", "technical_reject", "quarantine_corrupt_source_request_existing_valid_source");
  }
  if (evidence?.sourceHash === sourceHash && evidence.analysisStatus === "complete" && validAutomaticEvidence(evidence)) {
    const existing = decideQualityGateV2({ ...evidence, manualReview: undefined }, policy);
    if (existing.verdict === "reject") return result("REJECT", existing.reason, "quarantine_failed_source_do_not_generate_or_resubmit");
  }
  if (!references.length) return result("WAITING", "product_reference_missing", "fetch_original_task_product_images_automatically");
  const refsValid = references.every((ref) => ref.verified === true && ref.origin === "original_task_product_image"
    && /^[a-f0-9]{64}$/.test(ref.sha256 || "") && ref.sha256 !== sourceHash);
  if (!refsValid) return result("WAITING", "product_reference_unverified", "verify_reference_hash_origin_and_task_binding");
  if (!evidence || evidence.sourceHash !== sourceHash) return result("WAITING", "automatic_evidence_missing_or_stale", "run_scoped_automatic_quality_check_after_cost_approval_if_needed");
  if (evidence.analysisStatus !== "complete" || !evidence.providerEvidence) {
    const retryable = ["provider_error", "schema_invalid"].includes(evidence.analysisStatus);
    return result("WAITING", retryable ? "automatic_detector_failed" : "automatic_evidence_incomplete",
      retryable ? "bounded_detector_recovery_preserve_completed_evidence" : "complete_product_artifact_temporal_evidence_automatically");
  }
  if (!validAutomaticEvidence(evidence)) return result("WAITING", "automatic_evidence_schema_invalid", "bounded_detector_recovery_preserve_completed_evidence");
  if (!evidence.referenceCoverage?.complete || !references.every((ref) =>
    evidence.referenceCoverage.references?.some((used) => used.sha256 === ref.sha256))) {
    return result("WAITING", "reference_evidence_not_bound", "recheck_automatically_using_verified_original_references");
  }
  const verdict = decideQualityGateV2({ ...evidence, manualReview: undefined }, policy);
  if (verdict.verdict === "accept") return result("READY", "automatic_checks_passed", "continue_scoped_clip_render_and_publish_final_review_pending");
  if (verdict.verdict === "reject") return result("REJECT", verdict.reason, "quarantine_failed_source_do_not_generate_or_resubmit");
  return result("WAITING", verdict.reason, "resolve_specific_automatic_quality_evidence_without_source_human_approval");
}
