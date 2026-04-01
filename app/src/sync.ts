import * as Y from "yjs";
import {
  S2,
  AppendRecord,
  BatchTransform,
  Producer,
  RangeNotSatisfiableError,
} from "@s2-dev/streamstore";
import type { ReadSession } from "@s2-dev/streamstore";
import type { SessionResponse } from "../../shared/types";
import { FLUSH_DEBOUNCE_MS, MAX_DOC_BYTES } from "../../shared/constants";

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
  initialText?: string
): Promise<SyncState> {
  const doc = new Y.Doc();
  const text = doc.getText("content");

  const s2 = new S2({ accessToken: session.s2Token });
  const stream = s2.basin(session.s2Basin).stream(session.stream);

  if (session.snapshotUrl) {
    const res = await fetch(session.snapshotUrl);
    if (res.ok) {
      const buf = await res.arrayBuffer();
      Y.applyUpdate(doc, new Uint8Array(buf), "remote");
    } else {
      throw new Error(`snapshot fetch failed: ${res.status}`);
    }
  }

  const appendSess = await stream.appendSession();
  const producer = new Producer(
    new BatchTransform({ lingerDurationMillis: FLUSH_DEBOUNCE_MS }),
    appendSess
  );

  let suppressLocal = false;
  let docTooLarge = false;
  let pendingCount = 0;

  doc.on("update", async (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || docTooLarge) return;
    pendingCount++;
    onStatus("Saving...");
    try {
      const ticket = await producer.submit(
        AppendRecord.bytes({ body: update })
      );
      await ticket.ack();
    } catch {
      onStatus("Offline");
      return;
    }
    pendingCount--;
    if (pendingCount === 0) onStatus("Saved");
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
    doc.transact(() => {
      text.insert(0, initialText);
    });
  }

  textarea.value = text.toString();
  textarea.scrollTop = 0;
  textarea.selectionStart = textarea.selectionEnd = 0;
  onTextChange(text.toString());

  let readSess: ReadSession<"bytes"> | null = null;
  let tailActive = true;
  let nextReadSeqNum = session.snapshotSeqNum;

  const startTail = async () => {
    while (tailActive) {
      try {
        readSess = await stream.readSession(
          {
            start: { from: { seqNum: nextReadSeqNum }, clamp: true },
            stop: { waitSecs: 30 },
          },
          { as: "bytes" }
        );
        for await (const rec of readSess) {
          if (!tailActive) break;
          nextReadSeqNum = rec.seqNum + 1;
          applyRecord(doc, rec.body);
        }
      } catch (e) {
        if (!tailActive) break;
        if (e instanceof RangeNotSatisfiableError) {
          console.warn("read position trimmed, restarting from tail");
          nextReadSeqNum = 0;
          continue;
        }
        console.error("read session error, retrying:", e);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  startTail();

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

  return {
    doc,
    text,
    destroy() {
      tailActive = false;
      readSess?.cancel().catch(() => {});
      producer.close().catch(() => {});
      stream.close().catch(() => {});
      doc.destroy();
    },
  };
}

function applyRecord(doc: Y.Doc, body: Uint8Array) {
  if (!body || body.length === 0) return;
  // Legacy: skip old JSON snapshot markers still in the stream
  try {
    JSON.parse(new TextDecoder().decode(body));
    return;
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
