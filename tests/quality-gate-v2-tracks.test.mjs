import assert from "node:assert/strict";
import test from "node:test";
import { evaluateArtifactTrack, evaluateMissingReferenceSafety, evaluateReferenceTrack } from "../lib/quality-gate-v2-tracks.mjs";

const evidence = ({ verdict = "accept", reference = true, hand = "none", body = "none", temporal = "none", product = "match" } = {}) => ({
  verdict,
  evidence: { technical: { verdict: "accept" }, referenceCoverage: { complete: reference }, providerEvidence: { artifacts: { hand: { severity: hand }, body: { severity: body }, temporal: { severity: temporal } }, product: { match: product, graphic_text_logo: product, color: product, structure: product } } },
});

test("Reference track measures only product labels and excludes technical reference false alarms", () => {
  const manifest = { samples: [{ id: "a", groundTruth: { wrongSku: true, productError: true, expectedVerdict: "reject" } }, { id: "b", groundTruth: { wrongSku: false, productError: false, expectedVerdict: "accept" } }] };
  const run = { results: [{ id: "a", ...evidence({ verdict: "reject", product: "mismatch" }) }, { id: "b", verdict: "reject", evidence: { technical: { verdict: "reject" }, referenceCoverage: { complete: false } } }] };
  const report = evaluateReferenceTrack(manifest, run);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.metrics.wrongSkuRecall, 1);
  assert.equal(report.metrics.productErrorRecall, 1);
  assert.equal(report.metrics.referenceMatchFailure, 0);
});

test("Missing-reference safety passes only with no accidental accept", () => {
  const manifest = { samples: [{ id: "a" }, { id: "b" }] };
  const safe = evaluateMissingReferenceSafety(manifest, { results: [{ id: "a", verdict: "review", reason: "evidence_insufficient" }, { id: "b", verdict: "review", reason: "evidence_insufficient" }, { id: "outside-subset", verdict: "accept" }] });
  assert.equal(safe.status, "PASS");
  const unsafe = evaluateMissingReferenceSafety(manifest, { results: [{ id: "a", verdict: "accept" }, { id: "b", verdict: "review", reason: "evidence_insufficient" }] });
  assert.equal(unsafe.status, "FAIL");
});

test("Artifact track reports hand, body, temporal recall independently", () => {
  const manifest = { samples: [{ id: "hand", groundTruth: { handArtifact: true, expectedVerdict: "reject" } }, { id: "body", groundTruth: { bodyArtifact: true, expectedVerdict: "reject" } }, { id: "temporal", groundTruth: { temporalArtifact: true, expectedVerdict: "reject" } }, { id: "normal", groundTruth: { expectedVerdict: "accept" } }] };
  const report = evaluateArtifactTrack(manifest, { results: [{ id: "hand", ...evidence({ verdict: "reject", hand: "critical" }) }, { id: "body", ...evidence({ verdict: "accept", body: "none" }) }, { id: "temporal", ...evidence({ verdict: "reject", temporal: "critical" }) }, { id: "normal", ...evidence({ verdict: "reject" }) }] }, { repeatability: 0.9 });
  assert.equal(report.metrics.handArtifact.recall, 1);
  assert.equal(report.metrics.bodyArtifact.recall, 0);
  assert.equal(report.metrics.temporalArtifact.recall, 1);
  assert.equal(report.metrics.artifactCriticalMiss, 1);
  assert.equal(report.metrics.falseRejectRate, 1);
  assert.equal(report.metrics.verdictRepeatability, 0.9);
});

test('OOTD composition accepts missing or invalid labels without a second provider request', async () => {
  const {requestProviderEvidence}=await import('../worker/quality-gate-v2.mjs');
  const anomaly={severity:'none',confidence:.9,region:'none',evidence_frames:[]};
  const base={schema_version:'quality-evidence-provider.v2',source_id:'shot-1',confidence:.95,usability:'usable',
    artifacts:{hand:anomaly,face:anomaly,body:anomaly,temporal:anomaly},
    product:{match:'match',graphic_text_logo:'match',color:'match',structure:'match',confidence:.95}};
  const valid={shotType:'back_full_body',framing:'close',printProminence:.9,confidence:.95};
  for(const label of [undefined,{...valid,printProminence:2},valid]){
    let calls=0;
    const result=await requestProviderEvidence({runner:{complete:async ({jsonSchema})=>{
      calls++;
      assert(jsonSchema.properties.ootd_composition);
      return {text:JSON.stringify({...base,ootd_composition:label})};
    }},sourceId:'shot-1',prompt:'fixture',videoType:'ootd',includeOotdComposition:true});
    assert.equal(calls,1);
    assert.equal(result.providerEvidence.sourceId,'shot-1');
    assert.deepEqual(result.ootdComposition,label===valid?valid:undefined);
  }
});

test('missing or low-confidence detail coordinates preserve the base quality response', async () => {
  const { requestProviderEvidence } = await import('../worker/quality-gate-v2.mjs');
  const { resolveOotdDetailCrop } = await import('../worker/ootd-detail-crop.mjs');
  const anomaly = { severity: 'none', confidence: .9, region: 'none', evidence_frames: [] };
  for (const detailBox of [undefined, { left: .3, top: .4, right: .6, bottom: .7, confidence: .5 }]) {
    let calls = 0;
    const result = await requestProviderEvidence({
      sourceId: 'shot', prompt: 'fixture', videoType: 'ootd', includeOotdComposition: true, locateDetail: true,
      runner: { complete: async ({ jsonSchema }) => {
        calls++;
        assert(jsonSchema.properties.detail_box);
        return { text: JSON.stringify({
          schema_version: 'quality-evidence-provider.v2', source_id: 'shot', confidence: .95, usability: 'usable',
          artifacts: { hand: anomaly, face: anomaly, body: anomaly, temporal: anomaly },
          product: { match: 'match', graphic_text_logo: 'match', color: 'match', structure: 'match', confidence: .95 },
          ootd_composition: { shotType: 'front_full_body', framing: 'medium', printProminence: .8, confidence: .95 },
          detail_box: detailBox,
        }) };
      } },
    });
    assert.equal(calls, 1);
    assert.equal(result.providerEvidence.sourceId, 'shot');
    assert.equal(resolveOotdDetailCrop(result.ootdComposition?.detailBox), null);
  }
});

import { decideQualityGateV2 } from "../lib/quality-evidence-v2.mjs";

test("rear OOTD visibility clears only unknown findings for confirmed hidden features", () => {
  const rear = {
    automaticOnly: true, videoType: "ootd", sampledFrames: [0, 1, 2, 3, 4],
    ootdComposition: { shotType: "back_full_body", confidence: 0.9 },
    ootdRearVisibility: { hand: "naturally_hidden", face: "naturally_hidden" },
    analysisStatus: "complete", technical: { verdict: "accept" },
    providerEvidence: { confidence: 0.95, usability: "usable", product: { color: "match" },
      artifacts: { hand: { severity: "unknown" }, face: { severity: "unknown" },
        body: { severity: "none" }, temporal: { severity: "none" } } },
  };
  assert.equal(decideQualityGateV2(rear).verdict, "accept");
  for (const patch of [
    { videoType: "unboxing" }, { automaticOnly: false }, { sampledFrames: [0] },
    { ootdComposition: { shotType: "front_full_body", confidence: 0.9 } },
    { ootdComposition: { shotType: "back_full_body", confidence: 0.79 } },
    { ootdRearVisibility: { hand: "visible_or_uncertain", face: "naturally_hidden" } },
    { ootdRearVisibility: undefined },
  ]) assert.equal(decideQualityGateV2({ ...rear, ...patch }).verdict, "review");
  for (const [severity, verdict] of [["suspected", "review"], ["critical", "reject"]]) {
    const sample = structuredClone(rear);
    sample.providerEvidence.artifacts.hand.severity = severity;
    assert.equal(decideQualityGateV2(sample).verdict, verdict);
  }
  rear.providerEvidence.product.color = "mismatch";
  assert.equal(decideQualityGateV2(rear).verdict, "reject");
});

test('paired garment evidence is advisory and uses the existing OOTD request', async () => {
  const { requestProviderEvidence } = await import('../worker/quality-gate-v2.mjs');
  const anomaly = { severity: 'none', confidence: .9, region: 'none', evidence_frames: [] };
  const pair = { front_reference: 0, back_reference: 1, dominance: 'back', confidence: .97 };
  for (const [videoType, pairedReferences, responsePair, images, accepted] of [
    ['ootd', ['front', 'back'], pair, ['front', 'back'], true],
    ['ootd', ['front', 'back'], undefined, ['front', 'back'], false],
    ['ootd', ['front', 'back'], { ...pair, confidence: .6 }, ['front', 'back'], false],
    ['ootd', ['front', 'back'], { ...pair, back_reference: 2 }, ['front', 'back'], false],
    ['ootd', ['front', 'back'], { ...pair, back_reference: 0 }, ['front', 'back'], false],
    ['ootd', ['front', 'back'], pair, ['same', 'same'], false],
    ['ootd', ['front', 'graphic_detail'], pair, ['front', 'detail'], false],
    ['ootd', ['front'], pair, ['front'], false],
    ['unboxing', ['front', 'back'], undefined, ['front', 'back'], false],
  ]) {
    let calls = 0;
    const result = await requestProviderEvidence({
      sourceId: 'shot', prompt: 'fixture', videoType, includeOotdComposition: true, pairedReferences, images,
      runner: { complete: async ({ jsonSchema }) => {
        calls++;
        assert.equal(Boolean(jsonSchema.properties.paired_print), videoType === 'ootd' && pairedReferences.length >= 2);
        return { text: JSON.stringify({
          schema_version: 'quality-evidence-provider.v2', source_id: 'shot', confidence: .95, usability: 'usable',
          artifacts: { hand: anomaly, face: anomaly, body: anomaly, temporal: anomaly },
          product: { match: 'match', graphic_text_logo: 'match', color: 'match', structure: 'match', confidence: .95 },
          ...(videoType === 'ootd' && { ootd_composition: { shotType: 'back_full_body', framing: 'medium', printProminence: .9, confidence: .95 }, paired_print: responsePair }),
        }) };
      } },
    });
    assert.equal(calls, 1);
    assert.equal(result.providerEvidence.sourceId, 'shot');
    assert.deepEqual(result.ootdComposition?.pairedPrint, accepted ? { frontIndex: 0, backIndex: 1, dominance: 'back', confidence: .97 } : undefined);
  }
});
