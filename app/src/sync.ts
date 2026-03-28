import * as Y from "yjs";
import { S2, AppendInput, AppendRecord } from "@s2-dev/streamstore";
import type { S2Stream } from "@s2-dev/streamstore";
import type { SessionResponse } from "../../shared/types";
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
  initialText?: string,
): Promise<SyncState> {
  const doc = new Y.Doc();
  const text = doc.getText("content");

  const s2 = new S2({ accessToken: session.s2Token });
  const stream = s2.basin(session.s2Basin).stream(session.stream);

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

  let nextSeqNum = session.snapshotSeqNum;
  try {
    nextSeqNum = await catchUp(stream, doc, nextSeqNum);
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
      await stream.append(
        AppendInput.create(
          updates.map((u) => AppendRecord.bytes({ body: u })),
        ),
      );
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
    if (suppressLocal) return;
    const { selectionStart, selectionEnd } = textarea;
    textarea.value = newVal;
    textarea.selectionStart = selectionStart;
    textarea.selectionEnd = selectionEnd;
  });

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

  if (initialText && text.length === 0) {
    doc.transact(() => { text.insert(0, initialText); });
  }

  let pollActive = true;
  const poll = async () => {
    while (pollActive) {
      try {
        nextSeqNum = await readNewRecords(stream, doc, nextSeqNum);
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

async function catchUp(
  stream: S2Stream,
  doc: Y.Doc,
  fromSeqNum: number,
): Promise<number> {
  let seqNum = fromSeqNum;
  while (true) {
    const batch = await stream.read(
      {
        start: { from: { seqNum } },
        stop: { limits: { count: 1000 } },
      },
      { as: "bytes" },
    );
    if (batch.records.length === 0) break;
    for (const rec of batch.records) {
      seqNum = rec.seqNum + 1;
      applyRecord(doc, rec.body);
    }
    if (batch.records.length < 1000) break;
  }
  return seqNum;
}

async function readNewRecords(
  stream: S2Stream,
  doc: Y.Doc,
  fromSeqNum: number,
): Promise<number> {
  const batch = await stream.read(
    {
      start: { from: { seqNum: fromSeqNum } },
      stop: { limits: { count: 100 } },
    },
    { as: "bytes" },
  );
  let seqNum = fromSeqNum;
  for (const rec of batch.records) {
    seqNum = rec.seqNum + 1;
    applyRecord(doc, rec.body);
  }
  return seqNum;
}

function applyRecord(doc: Y.Doc, body: Uint8Array) {
  if (!body || body.length === 0) return;
  try {
    JSON.parse(new TextDecoder().decode(body));
    return; // snapshot marker, skip
  } catch {
    // binary Yjs update
  }
  Y.applyUpdate(doc, body, "remote");
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
