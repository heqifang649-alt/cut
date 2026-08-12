import type { Batch, SampleTemplate } from "./types";
import type { AuthUser } from "./auth";
import { LEGACY_ARCHIVE_OWNER_ID } from "./tenant-paths.mjs";

export function accessibleOwnerIds(user: AuthUser) {
  return user.role === "admin" ? [user.id, LEGACY_ARCHIVE_OWNER_ID] : [user.id];
}

export function canAccessOwner(user: AuthUser, ownerId: string) {
  return accessibleOwnerIds(user).includes(ownerId);
}

export function canAccessBatch(user: AuthUser, batch: Batch | null | undefined) {
  return Boolean(batch && canAccessOwner(user, batch.ownerId));
}

export function canAccessTemplate(user: AuthUser, template: SampleTemplate | null | undefined) {
  return Boolean(template && canAccessOwner(user, template.ownerId));
}
