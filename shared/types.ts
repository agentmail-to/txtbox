export interface SessionResponse {
  docId: string;
  stream: string;
  s2Basin: string;
  s2Token: string;
  snapshotUrl: string | null;
  snapshotSeqNum: number;
  limits: {
    maxRecordBytes: number;
    maxOpsPerSec: number;
  };
}
