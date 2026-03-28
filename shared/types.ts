export interface SessionResponse {
  docId: string;
  stream: string;
  s2Endpoint: string;
  s2Token: string;
  snapshotUrl: string | null;
  limits: {
    maxRecordBytes: number;
    maxOpsPerSec: number;
  };
}

export interface SnapshotMarker {
  type: "snapshot";
  key: string;
  ts: number;
  seqNum: number;
}

export interface S2Tail {
  seq_num: number;
  timestamp: number;
}

export interface S2StreamInfo {
  name: string;
  created_at: string;
  deleted_at?: string | null;
}

export interface S2Record {
  seq_num: number;
  timestamp: number;
  headers?: [string, string][];
  body?: string;
}

export interface S2ReadBatch {
  records: S2Record[];
  tail?: S2Tail | null;
}

export interface S2ListStreamsResponse {
  streams: S2StreamInfo[];
  has_more: boolean;
}
