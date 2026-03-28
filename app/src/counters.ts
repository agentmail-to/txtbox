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

    elements.chars.textContent = `${chars} chars`;
    elements.words.textContent = `${words} words`;
    elements.lines.textContent = `${lines} lines`;
    elements.tokens.textContent = `${tokens} tokens`;
  };
}
