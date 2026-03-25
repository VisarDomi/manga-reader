export function extractJsonArray(html: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needles: [string, boolean][] = [
    [`\\"${escapedKey}\\"`, true],
    [`"${escapedKey}"`, false],
  ];

  for (const [needle, escaped] of needles) {
    const idx = html.indexOf(needle);
    if (idx === -1) continue;

    const rest = html.slice(idx + needle.length);
    const match = rest.match(/^\s*:\s*(\[[\s\S]*?\])/);
    if (!match) continue;

    let raw = match[1];
    if (escaped) {
      raw = raw.replace(/\\"/g, '"').replace(/\\\//g, '/');
    }

    try {
      JSON.parse(raw);
    } catch {
      continue;
    }

    return raw;
  }

  throw new Error(`Key "${key}" not found in HTML (tried both escaped and unescaped patterns)`);
}
