# Rollback plan

Do not execute as part of archival. Original build .next-owner-20261106 is retained in the active release.
Use scripts/deploy-video-type-20261112.mjs --rollback from the original development workspace only under applicable anomaly authorization. It verifies expected installed hashes, backup hashes, idle queues, and no pending unboxing tasks. Restore the 11 backed-up original modules, preserve the new lib/video-type.mjs by renaming it, restore only CUTFLOW_NEXT_DIST_DIR to .next-owner-20261106, and reload necessary idle consumers. Preserve data/storage/receipts/history and current claims/provider settings.
Do not roll back across later production changes; a module hash mismatch must stop rollback and be reviewed. Backup relative layout and original hashes are in rollback/original-modules and deployment.json. Never overwrite .env.local with an archived copy; none is included.
Production rollback has not been executed. Existing byte restoration rehearsal passed.
