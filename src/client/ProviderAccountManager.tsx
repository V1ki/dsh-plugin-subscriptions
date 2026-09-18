import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountPreferences, ProviderPreferences } from '../provider-settings.js'
import type { SubscriptionProvider } from './SubscriptionsSection.js'
import type { SubscriptionsKey } from './locales.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { accountModelRows, accountPoolSelection, mergeAccountChanges } from './account-preferences.js'
import type { AccountCatalogRow } from './account-preferences.js'
import { ProviderModelEditor } from './ProviderModelEditor.js'

interface Catalog { settings: ProviderPreferences; accounts: AccountCatalogRow[] }
interface Props {
  provider: SubscriptionProvider
  name: string
  rpc: ConnectionHandle['rpc']
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
  onClose: () => void
}
const border = '1px solid var(--dsw-alias-border-l2)'
const control: CSSProperties = {
  font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)',
  border, borderRadius: 8, padding: '7px 12px', minWidth: 0,
}
const button: CSSProperties = { ...control, cursor: 'pointer' }
const hint: CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' }
const stack: CSSProperties = { display: 'grid', gap: 12, minWidth: 0 }
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }

/** Native top-layer dialog provides keyboard containment, Escape and focus restoration. */
export function ProviderAccountManager({ provider, name, rpc, t, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const description = useId()
  const [catalog, setCatalog] = useState<Catalog>()
  const [changes, setChanges] = useState<Record<string, AccountPreferences>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const alive = useRef(true)
  const saveLock = useRef(false)
  useEffect(() => {
    alive.current = true
    const element = dialog.current!
    const previous = document.activeElement
    element.showModal()
    return () => {
      alive.current = false
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    void callSubscriptionsAuth<Catalog>(rpc, 'providerSettings', { provider }).then(data => {
      if (current) setCatalog(data)
    }).catch(error => {
      if (current) setError(t('accountsLoadFailed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [provider, rpc, attempt])

  function edit(key: string, next: AccountPreferences) {
    setChanges(current => ({ ...current, [key]: next }))
  }
  async function save() {
    if (saveLock.current) return
    saveLock.current = true
    setSaving(true)
    setError('')
    try {
      // The model editor may have saved after this dialog loaded. Never write
      // its stale visibility/context/tool fields back with our account edits.
      const latest = await callSubscriptionsAuth<Catalog>(rpc, 'providerSettings', { provider })
      if (!alive.current) return
      await callSubscriptionsAuth(rpc, 'setProviderSettings', {
        provider, settings: mergeAccountChanges(latest.settings, changes),
      })
      if (alive.current) onClose()
    } catch (error) {
      if (alive.current) setError(t('accountsSaveFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      saveLock.current = false
      if (alive.current) setSaving(false)
    }
  }
  return <dialog ref={dialog} aria-labelledby={title} aria-describedby={description}
    onCancel={event => { if (saveLock.current) event.preventDefault() }} onClose={onClose}
    style={{ width: 620, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', boxSizing: 'border-box',
      padding: 0, border, borderRadius: 16, color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)', boxShadow: '0 20px 70px #0004', overflow: 'auto' }}>
    <div style={{ ...stack, padding: 20 }}>
      <header style={{ ...actions, justifyContent: 'space-between' }}>
        <h2 id={title} style={{ margin: 0, fontSize: 18 }}>{t('accountsTitle', { provider: name })}</h2>
        <button type="button" autoFocus style={button} disabled={saving} onClick={onClose}>{t('imageClose')}</button>
      </header>
      <p id={description} style={hint}>{t('accountsHint')}</p>
      {error && <p role="alert" style={{ ...hint, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</p>}
      {loading && <p role="status" style={hint}>{t('accountsLoading')}</p>}
      {!loading && !catalog && <button type="button" style={button} onClick={() => setAttempt(value => value + 1)}>{t('modelDefaultsRetry')}</button>}
      {catalog && <fieldset disabled={saving || loading} style={{ ...stack, border: 0, margin: 0, padding: 0 }}>
        {catalog.accounts.length === 0 && <p style={hint}>{t('accountsEmpty')}</p>}
        {catalog.accounts.map(account => {
          const preferences = changes[account.key] ?? catalog.settings.accounts?.[account.key] ?? {}
          const selected = accountPoolSelection(preferences, account.models)
          const models = accountModelRows(account, preferences)
          return <fieldset key={account.key} style={{ ...stack, border, borderRadius: 12, padding: 14, margin: 0 }}>
            <legend style={{ padding: '0 6px', fontWeight: 600, fontSize: 14, overflowWrap: 'anywhere', maxWidth: '100%' }}>{account.label}</legend>
            {account.unavailable && <p style={hint}>{t('accountsCatalogUnavailable')}</p>}
            <label style={{ ...stack, gap: 6 }}>
              <span style={{ fontSize: 12 }}>{t('accountsAlias')}</span>
              <input style={control} value={preferences.alias ?? ''} placeholder={account.label}
                onChange={event => {
                  const next = { ...preferences }
                  if (event.target.value.trim()) next.alias = event.target.value
                  else delete next.alias
                  edit(account.key, next)
                }} />
            </label>
            <label><input type="checkbox" checked={preferences.poolEnabled !== false}
              onChange={event => edit(account.key, { ...preferences, poolEnabled: event.target.checked })} /> {t('accountsPoolEnabled')}</label>
            <label><input type="checkbox" checked={preferences.independentEntry === true}
              onChange={event => edit(account.key, { ...preferences, independentEntry: event.target.checked })} /> {t('accountsIndependent')}</label>
            <p style={hint}>{t('accountsIndependentHint')}</p>
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>{t('accountsModels')} · {preferences.poolModels === undefined
                ? t('accountsModelsAll') : t('accountsModelsCount', { count: preferences.poolModels.length })}</summary>
              <div style={{ ...stack, marginTop: 12 }}>
                <p style={hint}>{t('accountsModelsHint')}</p>
                <label><input type="checkbox" checked={preferences.poolModels === undefined} onChange={event => {
                  const next = { ...preferences }
                  if (event.target.checked) delete next.poolModels
                  else next.poolModels = account.models.map(model => model.id)
                  edit(account.key, next)
                }} /> {t('accountsModelsAutomatic')}</label>
                <div style={actions}>
                  <button type="button" style={button} onClick={() => edit(account.key, { ...preferences, poolModels: models.map(model => model.id) })}>{t('modelsSelectAll')}</button>
                  <button type="button" style={button} onClick={() => edit(account.key, { ...preferences, poolModels: [] })}>{t('modelsSelectNone')}</button>
                </div>
                <div style={{ ...stack, gap: 8, maxHeight: 240, overflowY: 'auto' }}>
                  {models.map(model => <label key={model.id} style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
                    <input type="checkbox" checked={selected.has(model.id)} onChange={event => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(model.id); else next.delete(model.id)
                      edit(account.key, { ...preferences, poolModels: [...next] })
                    }} /> {model.name}{model.unavailable && ` (${t('modelsUnavailable')})`}
                  </label>)}
                  {models.length === 0 && <p style={hint}>{t('accountsNoModels')}</p>}
                </div>
              </div>
            </details>
          </fieldset>
        })}
      </fieldset>}
      <ProviderModelEditor provider={provider} rpc={rpc} t={t} embedded />
      <footer style={{ ...actions, justifyContent: 'flex-end', borderTop: border, padding: '14px 0 0',
        position: 'sticky', bottom: 0, background: 'var(--dsw-alias-bg-layer-1)' }}>
        <button type="button" style={button} disabled={saving} onClick={onClose}>{t('cancel')}</button>
        <button type="button" style={{ ...button, fontWeight: 600 }} disabled={loading || saving || !Object.keys(changes).length}
          onClick={() => { void save() }}>{saving ? t('modelDefaultsSaving') : t('modelsSave')}</button>
      </footer>
    </div>
  </dialog>
}
