import type {
  S2ListStreamsResponse,
  S2ReadBatch,
  S2Tail,
} from "./types.js";
import { STREAM_NAME_PREFIX } from "./constants.js";

const S2_ACCOUNT_ENDPOINT = "https://aws.s2.dev";

export class S2Client {
  private basin: string;

  constructor(
    private basinEndpoint: string,
    private token: string,
  ) {
    const host = new URL(basinEndpoint).hostname;
    this.basin = host.split(".")[0];
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private url(
    path: string,
    params?: Record<string, string>,
    base = this.basinEndpoint,
  ): string {
    const u = new URL(path, base);
    if (params) {
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async listStreams(
    prefix: string = STREAM_NAME_PREFIX,
    limit = 1000,
    startAfter?: string,
  ): Promise<S2ListStreamsResponse> {
    const params: Record<string, string> = { prefix, limit: String(limit) };
    if (startAfter) params.start_after = startAfter;
    const res = await fetch(this.url("/v1/streams", params), {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`list-streams failed: ${res.status}`);
    return res.json() as Promise<S2ListStreamsResponse>;
  }

  async ensureStream(streamName: string): Promise<void> {
    const res = await fetch(this.url("/v1/streams"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ stream: streamName }),
    });
    if (res.ok || res.status === 409) return;
    throw new Error(`create-stream failed: ${res.status}`);
  }

  async checkTail(streamName: string): Promise<S2Tail> {
    const res = await fetch(
      this.url(`/v1/streams/${encodeURIComponent(streamName)}/records/tail`),
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`check-tail failed: ${res.status}`);
    const data = (await res.json()) as { tail: S2Tail };
    return data.tail;
  }

  async readRecords(
    streamName: string,
    opts: {
      seqNum?: number;
      tailOffset?: number;
      count?: number;
      format?: "raw" | "base64";
    } = {},
  ): Promise<S2ReadBatch> {
    const params: Record<string, string> = {};
    if (opts.seqNum !== undefined) params.seq_num = String(opts.seqNum);
    if (opts.tailOffset !== undefined)
      params.tail_offset = String(opts.tailOffset);
    if (opts.count !== undefined) params.count = String(opts.count);

    const res = await fetch(
      this.url(
        `/v1/streams/${encodeURIComponent(streamName)}/records`,
        params,
      ),
      {
        headers: this.headers({
          "s2-format": opts.format ?? "base64",
        }),
      },
    );
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    return res.json() as Promise<S2ReadBatch>;
  }

  async appendRecords(
    streamName: string,
    bodies: string[],
    format: "raw" | "base64" = "base64",
  ): Promise<{ tail: S2Tail }> {
    const records = bodies.map((body) => ({ body }));
    const res = await fetch(
      this.url(`/v1/streams/${encodeURIComponent(streamName)}/records`),
      {
        method: "POST",
        headers: this.headers({ "s2-format": format }),
        body: JSON.stringify({ records }),
      },
    );
    if (!res.ok) throw new Error(`append failed: ${res.status}`);
    return res.json() as Promise<{ tail: S2Tail }>;
  }

  async issueToken(
    id: string,
    streamName: string,
    expiresAt: string,
    ops: string[],
  ): Promise<string> {
    const res = await fetch(this.url("/v1/access-tokens", undefined, S2_ACCOUNT_ENDPOINT), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        id,
        expires_at: expiresAt,
        scope: {
          basins: { exact: this.basin },
          streams: { exact: streamName },
          ops,
        },
      }),
    });
    if (!res.ok) throw new Error(`issue-token failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }
}
