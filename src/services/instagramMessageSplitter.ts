/**
 * splitInstagramMessage — pure text splitter for Instagram's 1000-char message cap.
 *
 * Splits at `limit` (default 950, leaving headroom under Meta's 1000-char hard
 * cap), preferring a break at a paragraph boundary (\n\n), then a line break
 * (\n), then a space, and only hard-cutting mid-word when none of those exist
 * within the limit. Chunk boundaries are trimmed of incidental whitespace, but
 * no non-whitespace character is ever dropped or duplicated — rejoining all
 * chunks with the same separator that was trimmed reproduces the original text
 * (mod whitespace collapsed at the cut point).
 */
export function splitInstagramMessage(text: string, limit = 950): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    let cut = window.lastIndexOf("\n\n");
    if (cut <= 0) cut = window.lastIndexOf("\n");
    if (cut <= 0) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit; // hard split — no natural boundary in range

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}
