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
const urlHost = document.getElementById("url-host")!;
const urlSlug = document.getElementById("url-slug")!;
const copyBtn = document.getElementById("copy-url") as HTMLButtonElement;
const copyIcon = document.getElementById("copy-icon")!;

const updateCounters = setupCounters({
  chars: document.getElementById("chars")!,
  words: document.getElementById("words")!,
  lines: document.getElementById("lines")!,
  tokens: document.getElementById("tokens")!,
});

newDocBtn.addEventListener("click", () => {
  window.location.href = `/${generateDocId()}`;
});

const ICON_COPY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyIcon.innerHTML = ICON_CHECK;
    setTimeout(() => { copyIcon.innerHTML = ICON_COPY; }, 1500);
  } catch { /* clipboard not available */ }
}

copyBtn.addEventListener("click", copyUrl);

const docId = getDocIdFromUrl();

urlHost.textContent = window.location.host;

if (docId) {
  urlSlug.textContent = `/${docId}`;
  initCloud(docId);
} else {
  copyBtn.classList.add("hidden");
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
