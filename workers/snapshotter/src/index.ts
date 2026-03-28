import * as Y from "yjs";
import { S2, AppendInput, AppendRecord, RangeNotSatisfiableError } from "@s2-dev/streamstore";
import type { S2Stream } from "@s2-dev/streamstore";
import {
  STREAM_NAME_PREFIX,
  ACTIVE_DOC_WINDOW_MIN,
  MAX_SNAPSHOT_BYTES,
  snapshotKey,
} from "@txtbox/shared";

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
  const key = snapshotKey(docId);
  const doc = new Y.Doc();

  const existing = await env.SNAPSHOTS_BUCKET.head(key);
  const lastSeqNum = existing
    ? parseInt(existing.customMetadata?.lastSeqNum ?? "0", 10)
    : -1;
  const existingETag = existing?.etag ?? null;

  if (existing) {
    const obj = await env.SNAPSHOTS_BUCKET.get(key);
    if (obj) {
      const buf = await obj.arrayBuffer();
      Y.applyUpdate(doc, new Uint8Array(buf));
    }
  }

  const startSeq = lastSeqNum + 1;
  let seqNum = startSeq;

  try {
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
        Y.applyUpdate(doc, rec.body);
      }

      if (batch.records.length < 1000) break;
    }
  } catch (e) {
    if (e instanceof RangeNotSatisfiableError) {
      console.warn(`${streamName}: seqNum ${seqNum} out of range, skipping`);
      doc.destroy();
      return;
    }
    throw e;
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

  const putOptions: R2PutOptions = {
    customMetadata: { lastSeqNum: String(seqNum - 1) },
    onlyIf: existingETag
      ? { etagMatches: existingETag }
      : { etagDoesNotMatch: "*" },
  };

  try {
    await env.SNAPSHOTS_BUCKET.put(key, snapshot, putOptions);
  } catch {
    console.warn(`${streamName}: R2 precondition failed, another worker won the race`);
    doc.destroy();
    return;
  }

  try {
    await stream.append(
      AppendInput.create([AppendRecord.trim(seqNum - 1)]),
    );
  } catch (e) {
    console.warn(`${streamName}: trim failed:`, e);
  }

  doc.destroy();
}
