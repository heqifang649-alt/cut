import json, os
from datetime import datetime, timezone

batch_id = 'd737c0af-b50d-4e99-bdd6-e231cf2bab66'
batches_path = 'D:/自动剪辑网站/data/batches.json'

def batch_workspace(batch):
    if batch.get('storageVersion') == 2:
        return f"D:/自动剪辑网站/storage/users/{batch['ownerId']}/batches/{batch['id']}"
    return f"D:/自动剪辑网站/storage/batches/{batch['id']}"

# 1. Load Batch record before resolving its workspace.
with open(batches_path, 'r', encoding='utf-8') as f:
    batches = json.load(f)

# 2. Find batch
batch = None
for b in batches:
    if b.get('id') == batch_id:
        batch = b
        break

if not batch:
    print(f'ERROR: Batch {batch_id} not found')
    raise SystemExit(1)

workspace = batch_workspace(batch)
product_groups_path = f'{workspace}/product-groups.json'
ref_profile_path = f'{workspace}/reference-profile.json'
edl_path = f'{workspace}/edit/batch-edl.json'

# 3. Load disk artifacts from the resolved workspace.
with open(product_groups_path, 'r', encoding='utf-8') as f:
    product_detection = json.load(f)
with open(ref_profile_path, 'r', encoding='utf-8') as f:
    reference_profile = json.load(f)
with open(edl_path, 'r', encoding='utf-8') as f:
    edl = json.load(f)

print(f'BEFORE: status={batch.get("status")} progress={batch.get("progress")}% recoveryAttempts={batch.get("recoveryAttempts")}')
print(f'  productDetection: {bool(batch.get("productDetection"))}')
print(f'  referenceProfile: {bool(batch.get("referenceProfile"))}')

# 4. Restore state from disk artifacts
batch['productDetection'] = product_detection
batch['referenceProfile'] = reference_profile
batch['status'] = 'editing'
batch['progress'] = 45
batch['recoveryAttempts'] = 0
batch['error'] = None
batch['lastWorkerActivityAt'] = None
batch['updatedAt'] = datetime.now(timezone.utc).isoformat()

print()
print(f'AFTER: status={batch.get("status")} progress={batch.get("progress")}% recoveryAttempts={batch.get("recoveryAttempts")}')
print(f'  productDetection: {len(product_detection.get("groups", []))} groups')
print(f'  referenceProfile: duration={reference_profile.get("duration_seconds")}s')
print(f'  EDL: status={edl.get("status")} review_state={edl.get("review_state")}')

# 5. Atomic write
tmp_path = batches_path + '.tmp'
with open(tmp_path, 'w', encoding='utf-8') as f:
    json.dump(batches, f, ensure_ascii=False, indent=2)
os.replace(tmp_path, batches_path)
print()
print('OK: batches.json updated. Worker will resume from EDL on next tick.')
