/** Read plugin-owned JSON saved with or without a leading UTF-8 byte order mark. */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}
