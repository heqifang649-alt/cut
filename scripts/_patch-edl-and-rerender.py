import json, os
from datetime import datetime, timezone

batch_id = 'd737c0af-b50d-4e99-bdd6-e231cf2bab66'
batches_path = 'D:/自动剪辑网站/data/batches.json'

def batch_workspace(batch):
    if batch.get('storageVersion') == 2:
        return f"D:/自动剪辑网站/storage/users/{batch['ownerId']}/batches/{batch['id']}"
    return f"D:/自动剪辑网站/storage/batches/{batch['id']}"

with open(batches_path, 'r', encoding='utf-8') as f:
    batches = json.load(f)
batch = next((item for item in batches if item.get('id') == batch_id), None)
if not batch:
    raise SystemExit(f'ERROR: Batch {batch_id} not found')
edl_path = f"{batch_workspace(batch)}/edit/batch-edl.json"

# 1. Patch EDL: convert hook/cvr from strings to dicts
with open(edl_path, 'r', encoding='utf-8') as f:
    edl = json.load(f)

master = edl.get('master', {})
patched = []
for field in ('hook', 'cvr'):
    val = master.get(field)
    if isinstance(val, str):
        master[field] = {'text': val, 'secondary_text': ''}
        patched.append(field)

# 2. Save EDL
tmp = edl_path + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(edl, f, ensure_ascii=False, indent=2)
os.replace(tmp, edl_path)
print(f'Patched EDL: {patched}')

# 3. Restore batch state to re-trigger render
batch['status'] = 'editing'
batch['progress'] = 45
batch['recoveryAttempts'] = 0
batch['error'] = None
batch['lastWorkerActivityAt'] = None
batch['renderingLabel'] = '已修复 EDL hook/cvr 结构，等待重新渲染'
batch['updatedAt'] = datetime.now(timezone.utc).isoformat()

tmp = batches_path + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(batches, f, ensure_ascii=False, indent=2)
os.replace(tmp, batches_path)
print('OK: batch reset to editing, worker will pick up on next tick')
