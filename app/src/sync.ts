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

  if (session.snapshotUrl) {
    try {
      const res = await fetch(session.snapshotUrl);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        Y.applyUpdate(doc, new Uint8Array(buf));
      }
    } catch {
      // no snapshot, start empty
    }
  }

  textarea.value = text.toString();
  onTextChange(text.toString());

  let tailSeqNum = 0;
  try {
    const tailRes = await fetch(
      `${session.s2Endpoint}/v1/streams/${encodeURIComponent(session.stream)}/records/tail`,
      { headers: { Authorization: `Bearer ${session.s2Token}` } },
    );
    if (tailRes.ok) {
      const data = (await tailRes.json()) as { tail: { seq_num: number } };
      tailSeqNum = data.tail.seq_num;
    }
  } catch {
    // start from 0
  }

  let pendingUpdates: Uint8Array[] = [];
  let pendingBytes = 0;
  let flushTimeout: ReturnType<typeof setTimeout> | null = null;
  let isRemoteUpdate = false;
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
      return sendRecords([merged], onStatus, session, toSend);
    }

    return sendRecords(toSend, onStatus, session, toSend);
  };

  async function sendRecords(
    updates: Uint8Array[],
    onStatus: (s: string) => void,
    session: SessionResponse,
    original: Uint8Array[],
  ) {
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

  text.observe(() => {
    const newVal = text.toString();
    onTextChange(newVal);
    checkDocSize();
    if (isRemoteUpdate) {
      const { selectionStart, selectionEnd } = textarea;
      textarea.value = newVal;
      textarea.selectionStart = selectionStart;
      textarea.selectionEnd = selectionEnd;
    }
  });

  textarea.addEventListener("input", () => {
    const newVal = textarea.value;
    const currentVal = text.toString();
    if (newVal === currentVal) return;

    doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, newVal);
    });
  });

  let pollActive = true;
  const pollTail = async () => {
    while (pollActive) {
      try {
        const res = await fetch(
          `${session.s2Endpoint}/v1/streams/${encodeURIComponent(session.stream)}/records?seq_num=${tailSeqNum}&count=100`,
          {
            headers: {
              Authorization: `Bearer ${session.s2Token}`,
              "s2-format": "base64",
            },
          },
        );
        if (res.ok) {
          const batch = (await res.json()) as S2ReadBatch;
          for (const rec of batch.records) {
            if (rec.seq_num >= tailSeqNum) {
              tailSeqNum = rec.seq_num + 1;
            }
            if (!rec.body) continue;
            try {
              JSON.parse(rec.body);
              continue;
            } catch {
              // binary Yjs update
            }
            const update = base64ToUint8(rec.body);
            isRemoteUpdate = true;
            Y.applyUpdate(doc, update, "remote");
            isRemoteUpdate = false;
          }
        }
      } catch {
        // poll error, retry
      }
      await sleep(2000);
    }
  };
  pollTail();

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
