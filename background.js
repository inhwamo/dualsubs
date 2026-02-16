const BATCH_SIZE = 250;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "translateWithClaude") {
    handleTranslation(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message || String(err) });
    });
    return true; // keep the message channel open for async response
  }
});

async function handleTranslation({ apiKey, subtitles, sourceLang, targetLang }) {
  if (!apiKey) throw new Error("No API key provided.");
  if (!subtitles || subtitles.length === 0)
    throw new Error("No subtitles to translate.");

  const batches = [];
  for (let i = 0; i < subtitles.length; i += BATCH_SIZE) {
    batches.push(subtitles.slice(i, i + BATCH_SIZE));
  }

  const allTranslations = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const offset = b * BATCH_SIZE;
    const numberedLines = batch
      .map((sub, i) => `[${offset + i}] ${sub.text}`)
      .join("\n");

    const systemPrompt = [
      `You are a subtitle translator. Translate the following ${sourceLang} subtitles into natural, colloquial ${targetLang}.`,
      "Each line is prefixed with a number in brackets like [0]. Preserve that exact numbering in your output.",
      "Output ONLY the translated lines, one per line, with the same [N] prefix. Do not add any commentary or extra text.",
    ].join(" ");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: numberedLines }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 401) throw new Error("Invalid API key.");
      if (response.status === 429)
        throw new Error("Rate limited. Please wait a moment and try again.");
      throw new Error(`API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const translatedText =
      data.content && data.content[0] && data.content[0].text;
    if (!translatedText) throw new Error("Empty response from API.");

    const parsed = parseTranslatedLines(translatedText, batch.length, offset);
    allTranslations.push(...parsed);
  }

  // Merge translations with original subtitle data
  return {
    translated: subtitles.map((sub, i) => ({
      start: sub.start,
      dur: sub.dur,
      text: sub.text,
      translation: allTranslations[i] || sub.text,
    })),
  };
}

function parseTranslatedLines(text, expectedCount, offset) {
  const lines = text.split("\n").filter((l) => l.trim());
  const result = new Array(expectedCount).fill("");

  for (const line of lines) {
    const match = line.match(/^\[(\d+)\]\s*(.*)$/);
    if (match) {
      const idx = parseInt(match[1], 10) - offset;
      if (idx >= 0 && idx < expectedCount) {
        result[idx] = match[2].trim();
      }
    }
  }

  // Fallback: if parsing by index failed for most lines, use positional order
  const filled = result.filter((r) => r).length;
  if (filled < expectedCount * 0.5 && lines.length >= expectedCount * 0.5) {
    for (let i = 0; i < Math.min(lines.length, expectedCount); i++) {
      const clean = lines[i].replace(/^\[\d+\]\s*/, "").trim();
      if (clean) result[i] = clean;
    }
  }

  return result;
}
