interface CounterElements {
  chars: HTMLElement;
  words: HTMLElement;
  lines: HTMLElement;
  tokens: HTMLElement;
}

export function setupCounters(elements: CounterElements) {
  return (text: string) => {
    const chars = text.length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text === "" ? 0 : text.split("\n").length;
    const tokens = Math.ceil(chars / 4);

    elements.chars.innerHTML = `${chars} <span class="label">chars</span>`;
    elements.words.innerHTML = `${words} <span class="label">words</span>`;
    elements.lines.innerHTML = `${lines} <span class="label">lines</span>`;
    elements.tokens.innerHTML = `${tokens} <span class="label">tokens</span>`;
  };
}
