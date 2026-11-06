/** Synthetic values matching the five-window structure shown in the reference image. */
export function antigravityQuotaSummary() {
  const weekly = new Date(Date.now() + (24 + 23) * 3600000).toISOString()
  const session = new Date(Date.now() + (3 * 60 + 32) * 60000).toISOString()
  return { groups: [
    { displayName: 'Gemini Models', buckets: [
      { window: 'WINDOW_WEEKLY', remainingFraction: 0.99, resetTime: weekly },
      { window: 'WINDOW_5_HOUR', remainingFraction: 0.99, resetTime: session },
    ] },
    { displayName: 'Claude and GPT models', buckets: [
      { window: 'WINDOW_WEEKLY', remainingFraction: 1, resetTime: weekly },
      { window: 'WINDOW_5_HOUR', remainingFraction: 1, resetTime: session },
    ] },
    { displayName: 'Gemini 4 Argon', buckets: [
      { window: 'WINDOW_WEEKLY', remainingFraction: 0.67, resetTime: weekly },
    ] },
  ] }
}
