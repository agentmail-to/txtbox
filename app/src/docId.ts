const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function generateDocId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => BASE58_ALPHABET[b % BASE58_ALPHABET.length]).join("");
}

export function getDocIdFromUrl(): string {
  const path = window.location.pathname.replace(/^\/+/, "");
  return path || "";
}
