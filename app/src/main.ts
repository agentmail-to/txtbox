import { getDocIdFromUrl, generateDocId } from "./docId";
import { createSession } from "./api";
import { startSync } from "./sync";
import { setupCounters } from "./counters";

const textarea = document.getElementById("editor") as HTMLTextAreaElement;
const statusEl = document.getElementById("status")!;
const newDocBtn = document.getElementById("new-doc")!;

const updateCounters = setupCounters({
  chars: document.getElementById("chars")!,
  words: document.getElementById("words")!,
  lines: document.getElementById("lines")!,
  tokens: document.getElementById("tokens")!,
});

newDocBtn.addEventListener("click", () => {
  window.location.href = `/${generateDocId()}`;
});

let docId = getDocIdFromUrl();
if (!docId) {
  const id = generateDocId();
  history.replaceState(null, "", `/${id}`);
  docId = id;
}

document.title = `txt.box/${docId}`;

async function init() {
  statusEl.textContent = "Connecting...";
  try {
    const session = await createSession(docId);
    await startSync(
      session,
      textarea,
      (s) => { statusEl.textContent = s; },
      updateCounters,
    );
    statusEl.textContent = "Connected";
  } catch (err) {
    statusEl.textContent = "Offline";
    console.error("sync init failed:", err);
  }
}

init();
