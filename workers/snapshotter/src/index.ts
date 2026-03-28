import * as Y from "yjs";
import {
  S2Client,
  STREAM_NAME_PREFIX,
  SNAPSHOT_KEY_PREFIX,
  ACTIVE_DOC_WINDOW_MIN,
  MAX_SNAPSHOT_BYTES,
} from "@txtbox/shared";
import type { SnapshotMarker } from "@txtbox/shared";

interface Env {
  S2_ACCESS_TOKEN: string;
  S2_BASIN: string;
  SNAPSHOTS_BUCKET: R2Bucket;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(snapshotActiveDocs(env));
  },
};

async function snapshotActiveDocs(env: Env): Promise<void> {
  const s2 = new S2Client(env.S2_BASIN, env.S2_ACCESS_TOKEN);
  const cutoff = Date.now() - ACTIVE_DOC_WINDOW_MIN * 60 * 1000;

  let startAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const listing = await s2.listStreams(STREAM_NAME_PREFIX, 1000, startAfter);
    hasMore = listing.has_more;

    for (const stream of listing.streams) {
      startAfter = stream.name;
      if (stream.deleted_at) continue;

      try {
        const tail = await s2.checkTail(stream.name);
        if (tail.timestamp < cutoff) continue;
      } catch {
        continue;
      }

      try {
        await snapshotDoc(s2, env, stream.name);
      } catch (err) {
        console.error(`snapshot failed for ${stream.name}:`, err);
      }
    }
  }
}

async function snapshotDoc(
  s2: S2Client,
  env: Env,
  streamName: string,
): Promise<void> {
  const docId = streamName.slice(STREAM_NAME_PREFIX.length);
  const doc = new Y.Doc();

  const marker = await findLatestMarker(s2, streamName);

  if (marker) {
    const obj = await env.SNAPSHOTS_BUCKET.get(marker.key);
    if (obj) {
      const buf = await obj.arrayBuffer();
      Y.applyUpdate(doc, new Uint8Array(buf));
    }
  }

  const startSeq = marker ? marker.seqNum + 1 : 0;
  let seqNum = startSeq;
  let hasRecords = true;

  while (hasRecords) {
    const batch = await s2.readRecords(streamName, {
      seqNum,
      count: 1000,
      format: "base64",
    });

    if (batch.records.length === 0) break;

    for (const rec of batch.records) {
      seqNum = rec.seq_num + 1;
      if (!rec.body) continue;
      try {
        JSON.parse(rec.body);
        continue;
      } catch {
        // binary Yjs update
      }
      const bytes = base64ToUint8(rec.body);
      Y.applyUpdate(doc, bytes);
    }

    hasRecords = batch.records.length === 1000;
  }

  if (seqNum === startSeq) {
    doc.destroy();
    return;
  }

  const snapshot = Y.encodeStateAsUpdate(doc);

  if (snapshot.byteLength > MAX_SNAPSHOT_BYTES) {
    console.warn(`${streamName}: snapshot ${snapshot.byteLength}B exceeds limit, skipping`);
    doc.destroy();
    return;
  }

  const ts = Date.now();
  const key = `${SNAPSHOT_KEY_PREFIX}${docId}/${ts}.bin`;

  await env.SNAPSHOTS_BUCKET.put(key, snapshot);

  const markerRecord: SnapshotMarker = {
    type: "snapshot",
    key,
    ts,
    seqNum: seqNum - 1,
  };
  await s2.appendRecords(streamName, [JSON.stringify(markerRecord)], "raw");

  doc.destroy();
}

async function findLatestMarker(
  s2: S2Client,
  streamName: string,
): Promise<SnapshotMarker | null> {
  try {
    const batch = await s2.readRecords(streamName, {
      tailOffset: 50,
      format: "raw",
    });
    for (let i = batch.records.length - 1; i >= 0; i--) {
      const rec = batch.records[i];
      if (!rec.body) continue;
      try {
        const parsed = JSON.parse(rec.body);
        if (parsed.type === "snapshot") return parsed as SnapshotMarker;
      } catch {
        // skip binary
      }
    }
  } catch {
    // empty stream
  }
  return null;
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
