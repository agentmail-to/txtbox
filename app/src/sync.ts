import * as Y from "yjs";
import type { SessionResponse, S2ReadBatch } from "../../shared/types";
import {
  FLUSH_DEBOUNCE_MS,
  MAX_BATCH_BYTES,
  MAX_DOC_BYTES,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
} from "../../shared/constants";

export interface SyncState {
  doc: Y.Doc;
  text: Y.Text;
  destroy: () => void;
}

export async function startSync(
  session: SessionResponse,
  textarea: HTMLTextAreaElement,
  onStatus: (status: string) => void,
  onTextChange: (text: string) => void,
): Promise<SyncState> {
  const doc = new Y.Doc();
  const text = doc.getText("content");

  // Load snapshot if available
  if (session.snapshotUrl) {
    try {
      const res = await fetch(session.snapshotUrl);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        Y.applyUpdate(doc, new Uint8Array(buf), "remote");
      }
    } catch {
      // no snapshot, start empty
    }
  }

  // Replay all records from the stream after the snapshot
  let nextSeqNum = session.snapshotSeqNum;
  try {
    nextSeqNum = await catchUp(session, doc, nextSeqNum);
  } catch (e) {
    console.warn("catch-up failed, will retry via poll:", e);
  }

  textarea.value = text.toString();
  onTextChange(text.toString());

  let pendingUpdates: Uint8Array[] = [];
  let pendingBytes = 0;
  let flushTimeout: ReturnType<typeof setTimeout> | null = null;
  let suppressLocal = false;
  let consecutiveFailures = 0;
  let docTooLarge = false;

  const flushUpdates = async () => {
    flushTimeout = null;
    if (pendingUpdates.length === 0) return;

    const toSend = pendingUpdates;
    const toSendBytes = pendingBytes;
    pendingUpdates = [];
    pendingBytes = 0;

    if (toSendBytes > MAX_BATCH_BYTES) {
      const merged = Y.mergeUpdates(toSend);
      if (merged.byteLength > MAX_BATCH_BYTES) {
        onStatus("Update too large");
        pendingUpdates = [...toSend, ...pendingUpdates];
        pendingBytes = toSendBytes + pendingBytes;
        return;
      }
      return sendRecords([merged], toSend);
    }

    return sendRecords(toSend, toSend);
  };

  async function sendRecords(updates: Uint8Array[], original: Uint8Array[]) {
    onStatus("Saving...");
    try {
      const records = updates.map((u) => ({ body: uint8ToBase64(u) }));
      const res = await fetch(
        `${session.s2Endpoint}/v1/streams/${encodeURIComponent(session.stream)}/records`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.s2Token}`,
            "Content-Type": "application/json",
            "s2-format": "base64",
          },
          body: JSON.stringify({ records }),
        },
      );
      if (!res.ok) throw new Error(`append: ${res.status}`);
      consecutiveFailures = 0;
      onStatus("Saved");
    } catch {
      consecutiveFailures++;
      const delay = Math.min(
        BACKOFF_BASE_MS * 2 ** consecutiveFailures,
        BACKOFF_MAX_MS,
      );
      onStatus(`Retrying in ${Math.round(delay / 1000)}s...`);
      pendingUpdates = [...original, ...pendingUpdates];
      pendingBytes += original.reduce((s, u) => s + u.byteLength, 0);
      flushTimeout = setTimeout(flushUpdates, delay);
    }
  }

  function checkDocSize() {
    const size = new TextEncoder().encode(text.toString()).byteLength;
    if (size > MAX_DOC_BYTES && !docTooLarge) {
      docTooLarge = true;
      onStatus("Doc too large");
      textarea.setAttribute("readonly", "");
    } else if (size <= MAX_DOC_BYTES && docTooLarge) {
      docTooLarge = false;
      textarea.removeAttribute("readonly");
    }
  }

  // Queue local Yjs updates for S2 append
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    if (docTooLarge) return;

    pendingUpdates.push(update);
    pendingBytes += update.byteLength;

    if (pendingBytes >= MAX_BATCH_BYTES) {
      if (flushTimeout) clearTimeout(flushTimeout);
      flushUpdates();
    } else {
      if (flushTimeout) clearTimeout(flushTimeout);
      flushTimeout = setTimeout(flushUpdates, FLUSH_DEBOUNCE_MS);
    }
  });

  // When Yjs text changes (local or remote), sync to textarea
  text.observe(() => {
    const newVal = text.toString();
    onTextChange(newVal);
    checkDocSize();
    if (suppressLocal) return;
    const { selectionStart, selectionEnd } = textarea;
    textarea.value = newVal;
    textarea.selectionStart = selectionStart;
    textarea.selectionEnd = selectionEnd;
  });

  // When the user types, diff against Yjs and apply minimal operations
  textarea.addEventListener("input", () => {
    const newVal = textarea.value;
    const oldVal = text.toString();
    if (newVal === oldVal) return;

    suppressLocal = true;
    doc.transact(() => {
      applyDiff(text, oldVal, newVal);
    });
    suppressLocal = false;
  });

  // Poll for remote updates
  let pollActive = true;
  const poll = async () => {
    while (pollActive) {
      try {
        nextSeqNum = await readNewRecords(session, doc, nextSeqNum);
      } catch {
        // poll error, retry next cycle
      }
      await sleep(1000);
    }
  };
  poll();

  return {
    doc,
    text,
    destroy() {
      pollActive = false;
      if (flushTimeout) clearTimeout(flushTimeout);
      doc.destroy();
    },
  };
}

/** Read all records from seqNum to the current tail, apply Yjs updates. */
async function catchUp(
  session: SessionResponse,
  doc: Y.Doc,
  fromSeqNum: number,
): Promise<number> {
  let seqNum = fromSeqNum;
  let hasMore = true;
  while (hasMore) {
    const batch = await readBatch(session, seqNum, 1000);
    hasMore = batch.records.length > 0;
    for (const rec of batch.records) {
      seqNum = rec.seq_num + 1;
      applyRecord(doc, rec.body);
    }
  }
  return seqNum;
}

/** Read new records from seqNum, apply Yjs updates, return new seqNum. */
async function readNewRecords(
  session: SessionResponse,
  doc: Y.Doc,
  fromSeqNum: number,
): Promise<number> {
  const batch = await readBatch(session, fromSeqNum, 100);
  let seqNum = fromSeqNum;
  for (const rec of batch.records) {
    seqNum = rec.seq_num + 1;
    applyRecord(doc, rec.body);
  }
  return seqNum;
}

async function readBatch(
  session: SessionResponse,
  seqNum: number,
  count: number,
): Promise<S2ReadBatch> {
  const res = await fetch(
    `${session.s2Endpoint}/v1/streams/${encodeURIComponent(session.stream)}/records?seq_num=${seqNum}&count=${count}`,
    {
      headers: {
        Authorization: `Bearer ${session.s2Token}`,
        "s2-format": "base64",
      },
    },
  );
  if (!res.ok) throw new Error(`read: ${res.status}`);
  return res.json() as Promise<S2ReadBatch>;
}

function applyRecord(doc: Y.Doc, body: string | undefined) {
  if (!body) return;
  // Skip snapshot markers (JSON records)
  try {
    JSON.parse(body);
    return;
  } catch {
    // binary Yjs update encoded as base64
  }
  Y.applyUpdate(doc, base64ToUint8(body), "remote");
}

/**
 * Compute minimal diff between old and new strings,
 * then apply targeted Yjs text operations.
 */
function applyDiff(ytext: Y.Text, oldVal: string, newVal: string) {
  let start = 0;
  const minLen = Math.min(oldVal.length, newVal.length);
  while (start < minLen && oldVal[start] === newVal[start]) start++;

  let oldEnd = oldVal.length;
  let newEnd = newVal.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldVal[oldEnd - 1] === newVal[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const deleteCount = oldEnd - start;
  const insertText = newVal.slice(start, newEnd);

  if (deleteCount > 0) ytext.delete(start, deleteCount);
  if (insertText) ytext.insert(start, insertText);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
