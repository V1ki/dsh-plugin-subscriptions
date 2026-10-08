import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountPreferences, ProviderPreferences } from '../provider-settings.js'
import type { SubscriptionProvider } from './SubscriptionsSection.js'
import type { SubscriptionsKey } from './locales.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { accountModelRows, accountPoolSelection, mergeAccountChanges, mergeLatestAccounts } from './account-preferences.js'
import type { AccountCatalogRow } from './account-preferences.js'
import { ProviderModelEditor } from './ProviderModelEditor.js'
import type { ProviderModelEditorHandle } from './ProviderModelEditor.js'
import { notifyDisplayNameChange } from './display-name-events.js'
import { providerSettingsCss } from './provider-settings-styles.js'

interface Catalog { settings: ProviderPreferences; accounts: AccountCatalogRow[] }
interface Props {
  provider: SubscriptionProvider
  name: string
  rpc: ConnectionHandle['rpc']
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
  onClose: () => void
}
const border = '0.5px solid var(--dsw-alias-border-l2)'
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
  const [saveError, setSaveError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [modelsDirty, setModelsDirty] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [nameDirty, setNameDirty] = useState(false)
  const alive = useRef(true)
  const saveLock = useRef(false)
  const editor = useRef<ProviderModelEditorHandle>(null)
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
      if (current) { setCatalog(data); setDisplayName(data.settings.displayName ?? '') }
    }).catch(error => {
      if (current) setError(t('accountsLoadFailed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [provider, rpc, attempt])

  function edit(key: string, next: AccountPreferences) {
    setChanges(current => ({ ...current, [key]: next }))
  }
  /**
   * One submit for both drafts: the model editor's (visibility, effort,
   * context, tools) and this dialog's account edits. A failure keeps the
   * dialog open with every edit intact.
   */
  async function save() {
    if (saveLock.current) return
    // An invalid model draft (e.g. a malformed context window) blocks the
    // whole submit; the editor shows the reason next to the field.
    const models = editor.current === null ? { efforts: [] } : editor.current.collect()
    if (models === undefined) return
    saveLock.current = true
    setSaving(true)
    setSaveError('')
    let savedEfforts = 0
    try {
      for (const { model, effort } of models.efforts) {
        await callSubscriptionsAuth(rpc, 'setModelDefault', { provider, model, ...(effort ? { effort } : {}) })
        savedEfforts++
        if (!alive.current) return
      }
      // Re-read before writing: another client may have saved since this
      // dialog loaded, and a stale snapshot must never be written back.
      const latest = await callSubscriptionsAuth<Catalog>(rpc, 'providerSettings', { provider })
      if (!alive.current) return
      const base = models.settings === undefined ? latest.settings : mergeLatestAccounts(models.settings, latest.settings)
      const { displayName: _staleName, ...rest } = mergeAccountChanges(base, changes)
      const savedName = nameDirty ? displayName.trim() : latest.settings.displayName
      const settings = { ...rest, ...(savedName ? { displayName: savedName } : {}) }
      await callSubscriptionsAuth(rpc, 'setProviderSettings', { provider, settings })
      notifyDisplayNameChange(provider, settings.displayName)
      if (alive.current) onClose()
    } catch (error) {
      if (alive.current) {
        const message = error instanceof Error ? error.message : String(error)
        setSaveError((savedEfforts ? t('modelsPartialSave') + ' ' : '') + t('accountsSaveFailed', { message }))
      }
    } finally {
      saveLock.current = false
      if (alive.current) setSaving(false)
    }
  }
  return <dialog className="dsh-subscription-manager" ref={dialog} aria-labelledby={title} aria-describedby={description}
    onCancel={event => { if (saveLock.current) event.preventDefault() }} onClose={onClose}
    style={{ width: 620, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto' }}>
    <style>{providerSettingsCss}</style>
    <div style={{ ...stack, padding: 20 }}>
      <header style={{ ...actions, justifyContent: 'space-between' }}>
        <h2 id={title} style={{ margin: 0 }}>{t('accountsTitle', { provider: name })}</h2>
        <button type="button" autoFocus disabled={saving} onClick={onClose}>{t('imageClose')}</button>
      </header>
      <p id={description} className="dsh-subscription-hint">{t('accountsHint')}</p>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status" className="dsh-subscription-hint">{t('accountsLoading')}</p>}
      {!loading && !catalog && <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('modelDefaultsRetry')}</button>}
      {catalog && <fieldset disabled={saving || loading} style={{ ...stack, border: 0, margin: 0, padding: 0 }}>
        <section style={{ ...stack, gap: 6, paddingBottom: 8 }}>
          <label style={{ ...stack, gap: 6 }}>
            <strong>{t('subscriptionDisplayName')}</strong>
            <input maxLength={80} value={displayName} placeholder={name}
              onChange={event => { setDisplayName(event.target.value); setNameDirty(true) }} />
          </label>
          <div style={{ ...actions, justifyContent: 'space-between' }}>
            <small className="dsh-subscription-hint">{t('subscriptionDisplayNameHint')}</small>
            <button type="button" disabled={!displayName}
              onClick={() => { setDisplayName(''); setNameDirty(true) }}>{t('displayNameReset')}</button>
          </div>
        </section>
        {catalog.accounts.length === 0 && <p className="dsh-subscription-hint">{t('accountsEmpty')}</p>}
        {catalog.accounts.map(account => {
          const preferences = changes[account.key] ?? catalog.settings.accounts?.[account.key] ?? {}
          const selected = accountPoolSelection(preferences, account.models)
          const models = accountModelRows(account, preferences)
          return <fieldset key={account.key} style={{ ...stack, border, borderRadius: 'var(--dsw-radius-lg, 12px)', padding: 14, margin: 0 }}>
            <legend style={{ padding: '0 6px', overflowWrap: 'anywhere', maxWidth: '100%' }}>{account.label}</legend>
            {account.unavailable && <p className="dsh-subscription-hint">{t('accountsCatalogUnavailable')}</p>}
            <label style={{ ...stack, gap: 6 }}>
              <span className="dsh-subscription-label">{t('accountsAlias')}</span>
              <input value={preferences.alias ?? ''} placeholder={account.label}
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
            <p className="dsh-subscription-hint">{t('accountsIndependentHint')}</p>
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>{t('accountsModels')} · {preferences.poolModels === undefined
                ? t('accountsModelsAll') : t('accountsModelsCount', { count: preferences.poolModels.length })}</summary>
              <div style={{ ...stack, marginTop: 12 }}>
                <p className="dsh-subscription-hint">{t('accountsModelsHint')}</p>
                <label><input type="checkbox" checked={preferences.poolModels === undefined} onChange={event => {
                  const next = { ...preferences }
                  if (event.target.checked) delete next.poolModels
                  else next.poolModels = account.models.map(model => model.id)
                  edit(account.key, next)
                }} /> {t('accountsModelsAutomatic')}</label>
                <div style={actions}>
                  <button type="button" onClick={() => edit(account.key, { ...preferences, poolModels: models.map(model => model.id) })}>{t('modelsSelectAll')}</button>
                  <button type="button" onClick={() => edit(account.key, { ...preferences, poolModels: [] })}>{t('modelsSelectNone')}</button>
                </div>
                <div style={{ ...stack, gap: 8, maxHeight: 240, overflowY: 'auto' }}>
                  {models.map(model => <label key={model.id} style={{ overflowWrap: 'anywhere' }}>
                    <input type="checkbox" checked={selected.has(model.id)} onChange={event => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(model.id); else next.delete(model.id)
                      edit(account.key, { ...preferences, poolModels: [...next] })
                    }} /> {model.name}{model.unavailable && ` (${t('modelsUnavailable')})`}
                  </label>)}
                  {models.length === 0 && <p className="dsh-subscription-hint">{t('accountsNoModels')}</p>}
                </div>
              </div>
            </details>
          </fieldset>
        })}
      </fieldset>}
      <ProviderModelEditor ref={editor} provider={provider} rpc={rpc} t={t} disabled={saving} onDirtyChange={setModelsDirty} />
      <footer style={{ ...stack, gap: 8, borderTop: border, padding: '14px 0 8px',
        position: 'sticky', bottom: 0, background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))' }}>
        {saveError && <p role="alert">{saveError}</p>}
        <div style={{ ...actions, justifyContent: 'flex-end' }}>
          <button type="button" disabled={saving} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="dsh-subscription-primary" disabled={loading || saving || (!Object.keys(changes).length && !modelsDirty && !nameDirty)}
            onClick={() => { void save() }}>{saving ? t('modelDefaultsSaving') : t('modelsSave')}</button>
        </div>
      </footer>
    </div>
  </dialog>
}
