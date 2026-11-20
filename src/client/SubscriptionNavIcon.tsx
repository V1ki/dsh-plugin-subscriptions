/** Decorative subscription-card glyph; the settings shell supplies its size. */
export function SubscriptionNavIcon({ size }: { size: number; active: boolean }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3 9h18M7 15h4" />
  </svg>
}
