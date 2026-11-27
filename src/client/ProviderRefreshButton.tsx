import { ProviderActionIcon } from './ProviderActionIcon.js'

export function ProviderRefreshButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return <button type="button" className="dsh-subscription-quiet" style={{ gap: 6, marginLeft: 'auto' }}
    disabled={disabled} onClick={onClick}>
    <ProviderActionIcon icon="refresh" />
    {label}
  </button>
}
