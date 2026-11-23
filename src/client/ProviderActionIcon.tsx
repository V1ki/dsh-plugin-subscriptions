export function ProviderActionIcon({ icon }: { icon: 'add' | 'manage' | 'refresh' }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {icon === 'add' ? <path d="M12 5v14M5 12h14" /> : icon === 'refresh' ? <>
      <path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2" />
    </> : <>
      <path d="M10 3h4l.6 2.6 1.5.9 2.6-.8 2 3.5-2 1.8v2l2 1.8-2 3.5-2.6-.8-1.5.9L14 21h-4l-.6-2.6-1.5-.9-2.6.8-2-3.5 2-1.8v-2l-2-1.8 2-3.5 2.6.8 1.5-.9z" />
      <circle cx="12" cy="12" r="2.7" />
    </>}
  </svg>
}
