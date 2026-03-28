import {
  S2Client,
  STREAM_NAME_PREFIX,
  DOC_ID_PATTERN,
  DOC_ID_MAX_LENGTH,
  MAX_RECORD_BYTES,
  MAX_OPS_PER_SEC,
  SNAPSHOT_KEY_PREFIX,
} from "@txtbox/shared";

interface Env {
  S2_ACCESS_TOKEN: string;
  S2_BASIN: string;
  R2_PUBLIC_BASE: string;
  SESSION_LIMITER: RateLimit;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TOKEN_TTL_SECONDS = 3600;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/session" && request.method === "POST") {
      return handleSession(request, env);
    }

    return json({ error: "not found" }, 404);
  },
};

async function handleSession(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const docId = url.searchParams.get("doc");

  if (
    !docId ||
    docId.length === 0 ||
    docId.length > DOC_ID_MAX_LENGTH ||
    !DOC_ID_PATTERN.test(docId)
  ) {
    return json({ error: "invalid doc id" }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.SESSION_LIMITER.limit({
    key: `${ip}:${docId}`,
  });
  if (!success) {
    return json({ error: "rate limited" }, 429);
  }

  const s2 = new S2Client(env.S2_BASIN, env.S2_ACCESS_TOKEN);
  const streamName = `${STREAM_NAME_PREFIX}${docId}`;

  await s2.ensureStream(streamName);

  const expiresAt = new Date(
    Date.now() + TOKEN_TTL_SECONDS * 1000
  ).toISOString();
  const tokenId = `session/${docId}/${Date.now()}`;
  const s2Token = await s2.issueToken(tokenId, streamName, expiresAt, [
    "read",
    "append",
    "check-tail",
  ]);

  const snapshot = await findLatestSnapshot(s2, streamName, env);

  return json({
    docId,
    stream: streamName,
    s2Endpoint: s2.endpoint,
    s2Token,
    snapshotUrl: snapshot.url,
    snapshotSeqNum: snapshot.seqNum,
    limits: {
      maxRecordBytes: MAX_RECORD_BYTES,
      maxOpsPerSec: MAX_OPS_PER_SEC,
    },
  });
}

async function findLatestSnapshot(
  s2: S2Client,
  streamName: string,
  env: Env,
): Promise<{ url: string | null; seqNum: number }> {
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
        if (parsed.type === "snapshot" && parsed.key) {
          return {
            url: `${env.R2_PUBLIC_BASE}/${parsed.key}`,
            seqNum: parsed.seqNum ?? 0,
          };
        }
      } catch {
        // binary Yjs record, skip
      }
    }
  } catch {
    // stream may be empty or not exist yet
  }
  return { url: null, seqNum: 0 };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
