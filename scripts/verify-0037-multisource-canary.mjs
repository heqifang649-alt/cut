import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename, mkdir, stat, realpath, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const repository = process.cwd();
const release = 'D:/CUT-Releases/20261029-unified-v2-r10';
const taskId = '340aba3a-cbfa-4adf-9458-1d25993afd32';
const expectedHash = '320b0cef0c64c070e2f1a6ca7e9205bcfa17f6f7df93a305c0858435cabf9ed9';
const oldHash = '9b630e4ad0983bd89569cffa988d37c005dccedbd04281ac23defc725635ebc3';
const key = `libtv-cut-lan-multi/2:${taskId}`;
const protectedTasks = ['d005f972-4dbb-4bb6-846f-0b284a7a2861', 'b6b2f9e7-e6e4-410a-b897-5768538cc592'];
const json = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const optional = async (file) => json(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
const integration = await json(path.join(release, 'data/classic-integration-runtime.json'));
const runtime = await json(path.join(release, 'config/cutflow-runtime.json'));
process.loadEnvFile(path.join(release, '.env.local'));
const local = path.join(repository, '0037-unified-v2-multisource-canary.json');
const remote = path.join(integration.nasRoot, 'COORD/ack', path.basename(local));
const evidence = path.join(repository, 'artifacts/0037');
await mkdir(evidence, { recursive: true });
const manifestFile = path.join(integration.nasRoot, 'inbox', `multi-${taskId}`, 'manifest.json');
const statusFile = path.join(integration.nasRoot, 'outbox', taskId, 'status.json');
const classicFile = path.join(integration.nasRoot, 'receipts/classic', `multi-${taskId}.json`);
const recordsFile = path.join(release, 'data/classic-multisource-records.json');
const receipt = {
  instructionId: '0037', state: 'blocked', repository, releaseRoot: release,
  canaryTaskId: taskId, canaryBatchId: null, batchId: null, revision: null,
  outputId: null, outputSha256: null, outputSize: null, cutStatus: null, classicStatus: null,
  classicReceiptPath: classicFile, manifestPath: manifestFile, manifestSha256: null, idempotencyKey: null,
  scanner: { root: release, nasRoot: integration.nasRoot, entrypoint: path.join(release, 'worker/classic-multisource-runner.mjs'), manifestMemoryCache: false },
  cacheRefresh: {
    initialBufferedHash: oldHash,
    commands: [
      { command: 'PowerShell Add-Type Uncached0037 CreateFile(FILE_FLAG_NO_BUFFERING) exact manifest path', exitCode: 1, error: 'ERROR_INVALID_PARAMETER' },
      { command: 'PowerShell FreshRead0037 CreateFileW(FILE_FLAG_NO_BUFFERING) exact manifest and READY', exitCode: 0, operationErrors: ['manifest CreateFileW error=87', 'READY CreateFileW error=87'] },
      { command: 'PowerShell FileStream(Open,Read,FileShare.None,RandomAccess) exact manifest and READY; dispose handles immediately; compute raw SHA256', exitCode: 0, manifestSha256: expectedHash, manifestSize: 4888, readySha256: expectedHash, idempotencyKey: key },
    ],
    result: 'One task-scoped exclusive read refreshed stale buffered UNC views. Subsequent Node buffered reads matched the current source. No NAS package or ACL was modified.',
    packageWrites: 0, runtimeCacheWrites: 0, supervisorRestarts: 0,
  },
  mutationsByVerifier: { postRequests: 0, taskCreations: 0, batchCreations: 0, statusInsertions: 0, renderReruns: 0, productionImplementationChanges: 0 },
  executedCommands: [], revisionObservations: [], outputVerification: [], blockers: [], remainingRisks: [],
  localReceipt: local, remoteReceipt: remote, startedAt: new Date().toISOString(),
};
const run = promisify(execFile);
async function command(executable, args, options = {}) {
  try {
    const result = await run(executable, args, { cwd: repository, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
    receipt.executedCommands.push({ executable, arguments: args, exitCode: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
    return result.stdout;
  } catch (error) {
    receipt.executedCommands.push({ executable, arguments: args, exitCode: error.code, stdout: error.stdout, stderr: error.stderr });
    throw error;
  }
}
const assert = (test, message) => { if (!test) throw new Error(message); };
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function atomic(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, file);
}
const protectedIdentity = (records) => records.filter((item) => protectedTasks.includes(item.taskId)).map((item) => ({ taskId: item.taskId, batchId: item.batchId, attempt: item.attempt, revision: item.revision, status: item.status }));
const normalize = (name) => path.resolve(name).toLowerCase();
let previous = null;
let manifest;
try {
  const raw = await readFile(manifestFile);
  manifest = JSON.parse(raw);
  const ready = await json(path.join(path.dirname(manifestFile), 'READY'));
  receipt.manifestSha256 = createHash('sha256').update(raw).digest('hex');
  receipt.idempotencyKey = manifest.idempotencyKey;
  receipt.readySha256 = ready.sha256;
  receipt.sourceCount = manifest.sources?.length;
  receipt.contractVersion = manifest.contractVersion;
  assert(receipt.manifestSha256 === expectedHash && ready.sha256 === expectedHash, 'CURRENT_MANIFEST_READY_HASH_MISMATCH');
  assert(manifest.taskId === taskId && manifest.idempotencyKey === key && manifest.contractVersion === 'libtv-cut-lan-multi/2' && manifest.sources.length === 2, 'CURRENT_PACKAGE_CONTRACT_MISMATCH');
  assert(manifest.sources[0].source.variant_id === '0af34027-b1d7-4b45-9304-ab8f2a5a4c8f' && manifest.sources[1].source.variant_id === '861809fe-addc-46ec-ba39-4d40ad8ac4a2', 'SOURCE_VARIANT_MISMATCH');
  await atomic(path.join(evidence, 'current-manifest.json'), raw);
  receipt.BUILD_ID = (await readFile(path.join(release, '.next-unified-v2-20261029/BUILD_ID'), 'utf8')).trim();
  assert(receipt.BUILD_ID === 'P9djDB68o1t1Nn6YDE3AC', 'ACTIVE_BUILD_MISMATCH');
  const rootResponse = await fetch('http://127.0.0.1:3001/', { signal: AbortSignal.timeout(10000) });
  assert(rootResponse.ok && (await rootResponse.text()).includes(receipt.BUILD_ID), 'ONLINE_BUILD_MISMATCH');
  receipt.branch = (await command('git', ['branch', '--show-current'])).trim();
  receipt.head = (await command('git', ['rev-parse', 'HEAD'])).trim();
  receipt.protectedBefore = protectedIdentity(await json(recordsFile));
  receipt.cacheRefresh.oldHashRuntimeMatches = [];
  for (const relative of ['data', 'data/classic-multisource-contexts', 'data/classic-multisource-errors', 'data/classic-multisource-budgets', '.openai', '.next-unified-v2-20261029/cache']) {
    const directory = path.join(release, relative);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(directory, entry.name);
      if ((await stat(file)).size < 64 * 1024 * 1024 && (await readFile(file, 'utf8')).includes(oldHash)) receipt.cacheRefresh.oldHashRuntimeMatches.push(file);
    }
  }
  assert(!receipt.cacheRefresh.oldHashRuntimeMatches.length, 'OLD_HASH_STILL_IN_RUNTIME_CACHE');
  const queue = await json(path.join(release, 'data/service-queue.json'));
  receipt.queueAudit = { oldHashPresent: JSON.stringify(queue).includes(oldHash), taskEntries: (queue.tasks || []).filter((item) => JSON.stringify(item).includes(taskId)) };
  assert(!receipt.queueAudit.oldHashPresent, 'OLD_HASH_STILL_IN_QUEUE');
  const referenceCounts = new Map();
  for (const ref of manifest.productReferences || []) referenceCounts.set(ref.refId, (referenceCounts.get(ref.refId) || 0) + 1);
  receipt.referenceValidation = {
    duplicateReferenceIds: [...referenceCounts].filter(([, count]) => count > 1).map(([refId, count]) => ({ refId, count })),
    references: (manifest.productReferences || []).map(({ refId, sourceOrder, relativePath }) => ({ refId, sourceOrder, relativePath })),
    validator: path.join(release, 'lib/classic-multisource.mjs:verifyMultisourceReferences'),
  };
  const validationCode = `
    const fs=require('node:fs/promises'),path=require('node:path');
    const {pathToFileURL}=require('node:url');
    (async()=>{
      const root=${JSON.stringify(release)};
      process.loadEnvFile(path.join(root,'.env.local'));
      const {multisourceConfig,verifyMultisourceReferences}=await import(pathToFileURL(path.join(root,'lib/classic-multisource.mjs')));
      const config=multisourceConfig(process.env,root);
      const manifest=JSON.parse(await fs.readFile(${JSON.stringify(manifestFile)},'utf8'));
      console.log(JSON.stringify({gate:config.gate,taskId:manifest.taskId}));
      await verifyMultisourceReferences(config,{taskId:manifest.taskId,handoffKey:manifest.handoffKey},manifest);
      console.log('REFERENCE_VALIDATION_PASSED');
    })().catch(error=>{console.error(JSON.stringify({code:error.code||error.message,message:error.message}));process.exitCode=1;});
  `;
  try {
    await command(process.execPath, ['-e', validationCode]);
    receipt.referenceValidation.result = 'passed';
  } catch (error) {
    receipt.referenceValidation.result = 'failed';
    receipt.referenceValidation.error = String(error.stderr || '').includes('INVALID_PRODUCT_REFERENCE') ? 'INVALID_PRODUCT_REFERENCE' : 'REFERENCE_VALIDATION_FAILED';
    throw new Error(receipt.referenceValidation.duplicateReferenceIds.length && receipt.referenceValidation.error === 'INVALID_PRODUCT_REFERENCE'
      ? 'INVALID_PRODUCT_REFERENCE_DUPLICATE_REF_ID_ACROSS_SOURCES' : receipt.referenceValidation.error);
  }
  receipt.sourceVerification = [];
  for (const source of manifest.sources) {
    const file = path.join(path.dirname(manifestFile), ...source.relativePath.split('/'));
    const size = (await stat(file)).size;
    const sha256 = await digest(file);
    assert(size === (source.size ?? source.size_bytes) && sha256 === source.sha256, 'SOURCE_SIZE_HASH_MISMATCH');
    receipt.sourceVerification.push({ clipId: source.clipId, variantId: source.source.variant_id, file, size, sha256 });
  }
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const records = await json(recordsFile);
    assert(JSON.stringify(protectedIdentity(records)) === JSON.stringify(receipt.protectedBefore), 'PROTECTED_SINGLE_SOURCE_IDENTITY_CHANGED');
    const matches = records.filter((item) => item.taskId === taskId);
    assert(matches.length <= 1, 'DUPLICATE_TASK_RECORD');
    const record = matches[0];
    if (record) {
      assert(record.manifestSha256 === expectedHash && record.idempotencyKey === key && record.sources.length === 2, 'ADMITTED_PACKAGE_MISMATCH');
      assert(record.batchId && !receipt.protectedBefore.some((item) => item.batchId === record.batchId) && record.batchId !== '5b3b5ae4-cb6c-4686-9936-d6359bc11a80', 'BATCH_MISSING_OR_REUSED');
      assert(!receipt.batchId || receipt.batchId === record.batchId, 'BATCH_ID_CHANGED');
      assert(records.filter((item) => item.batchId === record.batchId).length === 1 && (record.attempt || 0) <= 1, 'DUPLICATE_BATCH_OR_EXECUTION');
      receipt.batchId = receipt.canaryBatchId = record.batchId;
      receipt.executionAttempt = record.attempt || 0;
      receipt.costPolicy = record.policyReceipt?.costPolicy;
      receipt.durableRecord = record;
    }
    const status = await optional(statusFile);
    if (status) {
      assert(status.taskId === taskId && status.manifestSha256 === expectedHash && status.batchId === receipt.batchId && status.schemaVersion === 'yiying-cut-status/2', 'NAS_STATUS_IDENTITY_MISMATCH');
      assert(Number.isSafeInteger(status.revision) && status.revision > 0, 'INVALID_REVISION');
      const snapshot = JSON.stringify(status);
      if (previous) assert(status.revision >= previous.revision && (status.revision !== previous.revision || snapshot === previous.snapshot), 'REVISION_REGRESSED_OR_MUTATED');
      if (!previous || snapshot !== previous.snapshot) {
        receipt.revisionObservations.push({ at: new Date().toISOString(), revision: status.revision, status: status.status });
        await atomic(path.join(evidence, `revision-${status.revision}.json`), JSON.stringify(status, null, 2));
        console.log(JSON.stringify({ event: 'status', taskId, batchId: status.batchId, revision: status.revision, status: status.status }));
      }
      previous = { revision: status.revision, snapshot };
      receipt.revision = status.revision; receipt.cutStatus = status.status;
      assert(!status.error && status.status !== 'failed', `CUT_FAILED_${status.error?.code || 'UNKNOWN'}`);
      if (['completed', 'review'].includes(status.status)) {
        assert(status.outputs?.length && record?.attempt === 1, 'OUTPUTS_EMPTY_OR_ATTEMPT_INVALID');
        const response = await fetch(`http://127.0.0.1:3001/api/integrations/libtv-multisource/${taskId}`, { headers: { authorization: `Bearer ${process.env.LIBTV_BRIDGE_TOKEN}` }, signal: AbortSignal.timeout(10000) });
        const http = await response.json();
        assert(response.ok && !http.error && ['completed', 'review'].includes(http.status) && http.revision === status.revision && http.batchId === status.batchId && http.manifestSha256 === expectedHash && JSON.stringify(http.outputs) === JSON.stringify(status.outputs), 'GET_NAS_STATUS_MISMATCH');
        receipt.authenticatedGet = { statusCode: response.status, body: http };
        if (!receipt.outputVerification.length) {
          const edit = path.join(runtime.workRoot, 'classic-multisource', taskId, 'edit');
          const scheduleFile = path.join(edit, 'multisource-schedule-result.json');
          const edlFile = path.join(edit, 'render-plan-edl.json');
          const schedule = await json(scheduleFile);
          const edl = await json(edlFile);
          assert(schedule.taskId === taskId && schedule.manifestSha256 === expectedHash, 'SCHEDULE_IDENTITY_MISMATCH');
          const expectedSources = receipt.sourceVerification.map((item) => normalize(item.file));
          const products = edl.products.map((product) => ({ productId: product.product_id, segments: product.segments, usedSources: [...new Set(product.segments.filter((segment) => segment.duration > 0).map((segment) => normalize(segment.source_original || segment.source_name)))] }));
          receipt.multisourceComposition = { scheduleFile, scheduleSha256: await digest(scheduleFile), edlFile, edlSha256: await digest(edlFile), expectedSources, products };
          assert(products.length && products.every((product) => expectedSources.every((source) => product.usedSources.includes(source)) && product.usedSources.every((source) => expectedSources.includes(source))), 'OUTPUT_NOT_ACTUALLY_COMPOSED_FROM_BOTH_SOURCES');
          const canonicalOutbox = await realpath(path.join(integration.nasRoot, 'outbox', taskId));
          for (const output of status.outputs) {
            assert(output.relativePath?.startsWith(`outbox/${taskId}/`) && !output.relativePath.includes('\\') && !output.relativePath.split('/').includes('..'), 'OUTPUT_RELATIVE_PATH_ESCAPE');
            const file = await realpath(path.join(integration.nasRoot, ...output.relativePath.split('/')));
            const relative = path.relative(canonicalOutbox, file);
            assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'OUTPUT_CANONICAL_PATH_ESCAPE');
            const size = (await stat(file)).size;
            const sha256 = await digest(file);
            assert(size === output.size && sha256 === output.sha256, 'OUTPUT_SIZE_SHA256_MISMATCH');
            await command(runtime.ffmpegExecutable, ['-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], { timeout: 180000 });
            receipt.outputVerification.push({ outputId: output.outputId || output.id, relativePath: output.relativePath, file, size, sha256, fullDecode: 'passed' });
          }
          const first = receipt.outputVerification[0];
          receipt.outputId = first.outputId; receipt.outputSize = first.size; receipt.outputSha256 = first.sha256;
          console.log(JSON.stringify({ event: 'dual_source_output_verified', outputSha256: first.sha256, sourceCount: 2 }));
        }
        const classic = await optional(classicFile);
        if (classic) {
          receipt.classicReceipt = classic; receipt.classicStatus = classic.status;
          assert(classic.writer === 'classic' && classic.status === 'PENDING_REVIEW' && classic.taskId === taskId && classic.manifestSha256 === expectedHash && classic.batchId === receipt.batchId && classic.sourceCount === 2, 'CLASSIC_RECEIPT_IDENTITY_STATUS_MISMATCH');
          for (const output of receipt.outputVerification) assert(classic.outputs?.some((item) => (item.id || item.outputId) === output.outputId && item.sha256 === output.sha256 && (item.sizeBytes ?? item.size) === output.size), 'CLASSIC_OUTPUT_IDENTITY_MISMATCH');
          receipt.protectedAfter = protectedIdentity(await json(recordsFile));
          assert(JSON.stringify(receipt.protectedAfter) === JSON.stringify(receipt.protectedBefore), 'PROTECTED_TASK_CHANGED_AT_COMPLETION');
          assert(await digest(manifestFile) === expectedHash, 'SOURCE_PACKAGE_CHANGED_DURING_ACCEPTANCE');
          receipt.state = 'done'; receipt.blockers = [];
          receipt.remainingRisks = ['Creative content remains pending human review; technical acceptance is not creative approval.'];
          break;
        }
      }
    }
    assert(record?.status !== 'failed', `CUT_FAILED_${record?.error?.code || 'UNKNOWN'}`);
    await sleep(1000);
  }
  assert(receipt.state === 'done', receipt.batchId ? 'EXISTING_CANARY_OR_CLASSIC_RECEIPT_TIMEOUT_NO_RERUN' : 'CANARY_NOT_ADMITTED_AFTER_TASK_SCOPED_CACHE_REFRESH');
} catch (error) {
  receipt.state = 'blocked'; receipt.blockers = [error.message];
  receipt.remainingRisks = ['Technical acceptance incomplete; task identity preserved without a replacement batch or render retry.'];
}
const finalRecords = await json(recordsFile);
const finalMatches = finalRecords.filter((item) => item.taskId === taskId);
receipt.protectedAfter = protectedIdentity(finalRecords);
receipt.finalEvidence = {
  durableTaskRecordCount: finalMatches.length,
  nasStatus: await optional(statusFile), classicReceipt: await optional(classicFile),
  protectedTaskIdentitiesUnchanged: JSON.stringify(receipt.protectedBefore) === JSON.stringify(receipt.protectedAfter),
  sourceManifestSha256: await digest(manifestFile),
};
if (!finalMatches.length) {
  receipt.cutStatus = 'not_admitted';
  receipt.classicStatus = receipt.finalEvidence.classicReceipt?.status || 'unverified_no_receipt';
}
const finalGet = await fetch(`http://127.0.0.1:3001/api/integrations/libtv-multisource/${taskId}`, {
  headers: { authorization: `Bearer ${process.env.LIBTV_BRIDGE_TOKEN}` }, signal: AbortSignal.timeout(10000),
});
receipt.finalEvidence.authenticatedGet = { statusCode: finalGet.status, body: await finalGet.json() };
if (receipt.referenceValidation?.error === 'INVALID_PRODUCT_REFERENCE') receipt.requiredExternalCondition =
  'The current immutable two-source package repeats refId values across sourceOrder 1 and 2. Existing CUT validation requires unique reference identities with consistent per-source bindings. This attempt does not modify the package or validation rules, create another task/batch, or rerun rendering.';
receipt.finishedAt = receipt.updatedAt = new Date().toISOString();
const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
await atomic(local, bytes); await atomic(remote, bytes);
assert((await readFile(local)).equals(await readFile(remote)), 'RECEIPT_COPIES_DIFFER');
console.log(JSON.stringify({ event: 'final', state: receipt.state, blockers: receipt.blockers, BUILD_ID: receipt.BUILD_ID, canaryTaskId: taskId, batchId: receipt.batchId, revision: receipt.revision, outputSha256: receipt.outputSha256, cutStatus: receipt.cutStatus, classicStatus: receipt.classicStatus, localReceipt: local, remoteReceipt: remote, receiptCopiesMatch: true }));
process.exitCode = receipt.state === 'done' ? 0 : 2;
