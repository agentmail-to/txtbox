const STORAGE_KEY = "txtbox:draft";
const SAVE_DEBOUNCE_MS = 300;

export function startLocal(
  textarea: HTMLTextAreaElement,
  onTextChange: (text: string) => void,
): () => void {
  const saved = localStorage.getItem(STORAGE_KEY) ?? "";
  textarea.value = saved;
  onTextChange(saved);

  let timeout: ReturnType<typeof setTimeout> | null = null;

  const onInput = () => {
    const val = textarea.value;
    onTextChange(val);
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => localStorage.setItem(STORAGE_KEY, val), SAVE_DEBOUNCE_MS);
  };

  textarea.addEventListener("input", onInput);

  return () => {
    textarea.removeEventListener("input", onInput);
    if (timeout) clearTimeout(timeout);
  };
}

export function clearDraft() {
  localStorage.removeItem(STORAGE_KEY);
}
