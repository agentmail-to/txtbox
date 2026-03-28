export const MAX_RECORD_BYTES = 65_536;
export const MAX_OPS_PER_SEC = 20;
export const SNAPSHOT_INTERVAL_MIN = 5;
export const ACTIVE_DOC_WINDOW_MIN = 60;
export const SNAPSHOT_KEY_PREFIX = "snapshots/";
export const STREAM_NAME_PREFIX = "doc:";
export const DOC_ID_MAX_LENGTH = 64;
export const DOC_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MAX_DOC_BYTES = 5 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const FLUSH_DEBOUNCE_MS = 200;

export function snapshotKey(docId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${docId}/latest.bin`;
}
