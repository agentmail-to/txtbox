import type { SessionResponse } from "../../shared/types";

const API_BASE =
  import.meta.env.VITE_API_BASE ?? "https://api.txt.box";

export async function createSession(docId: string): Promise<SessionResponse> {
  const res = await fetch(`${API_BASE}/session?doc=${encodeURIComponent(docId)}`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`session failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
