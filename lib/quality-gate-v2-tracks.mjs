const ratio = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const resultMap = (run) => new Map((run?.results || []).map((item) => [item.id, item]));
const completeFor = (samples, results) => samples.every((sample) => results.has(sample.id));

export function evaluateReferenceTrack(manifest, run) {
  const results = resultMap(run);
  const samples = manifest.samples || [];
  const positive = (key) => samples.filter((sample) => sample.groundTruth?.[key]);
  const detected = (sample, key) => {
    const product = results.get(sample.id)?.evidence?.providerEvidence?.product || {};
    return key === "wrongSku" ? product.match === "mismatch" : [product.match, product.graphic_text_logo, product.color, product.structure].includes("mismatch");
  };
  const recall = (key) => ratio(positive(key).filter((sample) => detected(sample, key)).length, positive(key).length);
  const productCriticalMiss = samples.filter((sample) => sample.groundTruth?.expectedVerdict === "reject" && (sample.groundTruth?.wrongSku || sample.groundTruth?.productError) && results.get(sample.id)?.verdict === "accept");
  const referenceMatchFailure = samples.filter((sample) => {
    const evidence = results.get(sample.id)?.evidence;
    return evidence?.technical?.verdict === "accept" && !evidence?.referenceCoverage?.complete;
  });
  const verdicts = Object.fromEntries(["accept", "review", "reject"].map((verdict) => [verdict, samples.filter((sample) => results.get(sample.id)?.verdict === verdict).length]));
  return { track: "product-reference", status: completeFor(samples, results) ? "COMPLETE" : "INCOMPLETE", samples: samples.length, metrics: { wrongSkuRecall: recall("wrongSku"), productErrorRecall: recall("productError"), referenceMatchFailure: referenceMatchFailure.length, productCriticalMiss: productCriticalMiss.length, verdicts }, cases: { referenceMatchFailure: referenceMatchFailure.map((sample) => sample.id), productCriticalMiss: productCriticalMiss.map((sample) => sample.id) } };
}

export function evaluateMissingReferenceSafety(manifest, run) {
  const results = resultMap(run); const samples = manifest.samples || [];
  const count = (predicate) => samples.filter((sample) => predicate(results.get(sample.id))).length;
  const accidentalAccept = count((result) => result?.verdict === "accept");
  return { track: "missing-reference-safety", status: completeFor(samples, results) ? (accidentalAccept === 0 ? "PASS" : "FAIL") : "INCOMPLETE", samples: samples.length, metrics: { evidenceInsufficientRate: ratio(count((result) => result?.reason === "evidence_insufficient"), samples.length), reviewRate: ratio(count((result) => result?.verdict === "review"), samples.length), accidentalAcceptRate: ratio(accidentalAccept, samples.length), accidentalAccept } };
}

export function evaluateArtifactTrack(manifest, run, repeatability = null) {
  const results = resultMap(run); const samples = manifest.samples || [];
  const severity = (sample, key) => results.get(sample.id)?.evidence?.providerEvidence?.artifacts?.[key]?.severity === "critical";
  const metric = (truth, evidenceKey) => { const positives = samples.filter((sample) => sample.groundTruth?.[truth]); return { positives: positives.length, recall: ratio(positives.filter((sample) => severity(sample, evidenceKey)).length, positives.length) }; };
  const artifactCriticalMiss = samples.filter((sample) => sample.groundTruth?.expectedVerdict === "reject" && (sample.groundTruth?.handArtifact || sample.groundTruth?.bodyArtifact || sample.groundTruth?.temporalArtifact) && results.get(sample.id)?.verdict === "accept");
  const normal = samples.filter((sample) => sample.groundTruth?.expectedVerdict === "accept");
  const falseReject = normal.filter((sample) => results.get(sample.id)?.verdict === "reject");
  return { track: "artifact", status: completeFor(samples, results) ? "COMPLETE" : "INCOMPLETE", samples: samples.length, metrics: { handArtifact: metric("handArtifact", "hand"), bodyArtifact: metric("bodyArtifact", "body"), temporalArtifact: metric("temporalArtifact", "temporal"), artifactCriticalMiss: artifactCriticalMiss.length, falseRejectRate: ratio(falseReject.length, normal.length), verdictRepeatability: repeatability?.repeatability ?? null }, cases: { artifactCriticalMiss: artifactCriticalMiss.map((sample) => sample.id) } };
}
