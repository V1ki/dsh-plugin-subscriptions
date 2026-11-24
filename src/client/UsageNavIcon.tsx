/** Sidebar navigation glyph for the Subscription Usage dashboard; the host shell supplies its size. */
export function UsageNavIcon({ size }: { size: number; active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="13" width="4" height="7" rx="1.2" />
      <rect x="10" y="9" width="4" height="11" rx="1.2" />
      <rect x="17" y="4" width="4" height="16" rx="1.2" />
    </svg>
  )
}
