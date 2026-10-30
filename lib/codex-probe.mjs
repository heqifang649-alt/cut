import { classifyRecoveryError } from '../worker/recovery.mjs';
export function probeEventFailure(event) {
 if (!['error', 'turn.failed'].includes(event?.type)) return null;
 const error = new Error(String(event.message || event.error?.message || 'Codex executor stream failed.'));
 const classification = classifyRecoveryError(error);
 // An auth failure remains terminal even when the CLI labels it Reconnecting.
 if (event.type === 'error' && /reconnecting/i.test(error.message) && classification.kind !== 'codex_authentication') return null;
 return error;
}
