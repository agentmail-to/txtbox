import { getDocIdFromUrl, generateDocId } from "./docId";
import { createSession } from "./api";
import { startSync } from "./sync";
import { startLocal } from "./local";
import { setupCounters } from "./counters";

const INITIAL_CONTENT_KEY = "txtbox:initial";

const textarea = document.getElementById("editor") as HTMLTextAreaElement;
const statusEl = document.getElementById("status")!;
const newDocBtn = document.getElementById("new-doc")!;
const shareBtn = document.getElementById("share-doc")!;

const updateCounters = setupCounters({
  chars: document.getElementById("chars")!,
  words: document.getElementById("words")!,
  lines: document.getElementById("lines")!,
  tokens: document.getElementById("tokens")!,
});

newDocBtn.addEventListener("click", () => {
  window.location.href = `/${generateDocId()}`;
});

const docId = getDocIdFromUrl();

if (docId) {
  initCloud(docId);
} else {
  initLocal();
}

function initLocal() {
  document.title = "txt.box";
  shareBtn.classList.remove("hidden");
  statusEl.textContent = "Local";

  startLocal(textarea, updateCounters);

  shareBtn.addEventListener("click", () => {
    const text = textarea.value;
    sessionStorage.setItem(INITIAL_CONTENT_KEY, text);
    window.location.href = `/${generateDocId()}`;
  });
}

async function initCloud(docId: string) {
  document.title = `txt.box/${docId}`;
  newDocBtn.classList.remove("hidden");
  statusEl.textContent = "Connecting...";

  const initialText = sessionStorage.getItem(INITIAL_CONTENT_KEY) ?? undefined;
  sessionStorage.removeItem(INITIAL_CONTENT_KEY);
  if (initialText) {
    textarea.value = initialText;
    updateCounters(initialText);
  }

  try {
    const session = await createSession(docId);

    await startSync(
      session,
      textarea,
      (s) => { statusEl.textContent = s; },
      updateCounters,
      initialText,
    );

    statusEl.textContent = "Connected";
  } catch (err) {
    statusEl.textContent = "Offline";
    console.error("sync init failed:", err);
  }
}
