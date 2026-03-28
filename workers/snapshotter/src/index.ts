import * as Y from "yjs";
import { S2, AppendInput, AppendRecord } from "@s2-dev/streamstore";
import type { S2Stream } from "@s2-dev/streamstore";
import {
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
  const s2 = new S2({ accessToken: env.S2_ACCESS_TOKEN });
  const basin = s2.basin(env.S2_BASIN);
  const cutoff = Date.now() - ACTIVE_DOC_WINDOW_MIN * 60 * 1000;

  for await (const streamInfo of basin.streams.listAll({ prefix: STREAM_NAME_PREFIX })) {
    if (streamInfo.deletedAt) continue;

    const stream = basin.stream(streamInfo.name);
    try {
      const { tail } = await stream.checkTail();
      if (tail.timestamp.getTime() < cutoff) continue;
    } catch {
      continue;
    }

    try {
      await snapshotDoc(stream, env, streamInfo.name);
    } catch (err) {
      console.error(`snapshot failed for ${streamInfo.name}:`, err);
    }
  }
}

async function snapshotDoc(
  stream: S2Stream,
  env: Env,
  streamName: string,
): Promise<void> {
  const docId = streamName.slice(STREAM_NAME_PREFIX.length);
  const doc = new Y.Doc();

  const marker = await findLatestMarker(stream);

  if (marker) {
    const obj = await env.SNAPSHOTS_BUCKET.get(marker.key);
    if (obj) {
      const buf = await obj.arrayBuffer();
      Y.applyUpdate(doc, new Uint8Array(buf));
    }
  }

  const startSeq = marker ? marker.seqNum + 1 : 0;
  let seqNum = startSeq;

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
      if (!rec.body || rec.body.length === 0) continue;
      try {
        JSON.parse(new TextDecoder().decode(rec.body));
        continue; // snapshot marker, skip
      } catch {
        // binary Yjs update
      }
      Y.applyUpdate(doc, rec.body);
    }

    if (batch.records.length < 1000) break;
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
  await stream.append(
    AppendInput.create([
      AppendRecord.string({ body: JSON.stringify(markerRecord) }),
    ]),
  );

  doc.destroy();
}

async function findLatestMarker(
  stream: S2Stream,
): Promise<SnapshotMarker | null> {
  try {
    const batch = await stream.read(
      { start: { from: { tailOffset: 50 } } },
      { as: "bytes" },
    );
    for (let i = batch.records.length - 1; i >= 0; i--) {
      const rec = batch.records[i];
      if (!rec.body || rec.body.length === 0) continue;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(rec.body));
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
