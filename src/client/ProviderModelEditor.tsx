import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderPreferences, SubscriptionTool } from '../provider-settings.js'
import type { SubscriptionProvider } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { mergeLatestAccounts } from './account-preferences.js'
import type { SubscriptionsKey } from './locales.js'

interface ModelRow {
  id: string
  name: string
  contextWindow?: number
  defaultContextWindow?: number
  efforts?: { id: string; name: string }[]
  configured?: string
  maxContextWindow?: number
}
interface Catalog {
  provider: SubscriptionProvider
  settings: ProviderPreferences
  models: ModelRow[]
  tools: SubscriptionTool[]
}
interface Props {
  provider: SubscriptionProvider
  rpc: ConnectionHandle['rpc']
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
  /** Render the editor as an embedded section of the account manager dialog. */
  embedded?: boolean
}
const border = '1px solid var(--dsw-alias-border-l2, #ddd)'
const control: CSSProperties = {
  font: 'inherit', color: 'inherit', background: 'transparent', border,
  borderRadius: 8, padding: '6px 10px', minWidth: 0,
}
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }

/** Local draft: refreshes and failed saves never silently replace unsaved edits. */
export function ProviderModelEditor({ provider, rpc, t, embedded = false }: Props) {
  const [open, setOpen] = useState(embedded === true)
  const [catalog, setCatalog] = useState<Catalog>()
  const [draft, setDraft] = useState<ProviderPreferences>({})
  const [contexts, setContexts] = useState<Record<string, string>>({})
  const [efforts, setEfforts] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])

  function reset(data: Catalog) {
    setCatalog(data)
    setDraft(data.settings)
    setEfforts(Object.fromEntries(data.models.map(model => [model.id, model.configured ?? ''])))
    setContexts(Object.fromEntries(Object.entries(data.settings.contextWindows ?? {}).map(([id, value]) => [id, String(value)])))
    setDirty(false)
  }
  async function load(force = false) {
    const request = ++generation.current
    setBusy(true)
    setError('')
    try {
      const data = await callSubscriptionsAuth<Catalog>(rpc, 'providerSettings', { provider, force })
      if (generation.current === request) reset(data)
    } catch (error) {
      if (generation.current === request) setError(String(error instanceof Error ? error.message : error))
    } finally {
      if (generation.current === request) setBusy(false)
    }
  }
  function edit(next: ProviderPreferences) { setDraft(next); setDirty(true); setSaved(false) }
  useEffect(() => {
    if (embedded && !catalog && !busy) void load()
  }, [embedded])
  async function save() {
    const windows: Record<string, number> = Object.create(null) as Record<string, number>
    for (const [model, text] of Object.entries(contexts)) {
      if (!text.trim()) continue
      const value = Number(text)
      if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value <= 0) {
        setError(t('modelsContextInvalid', { model })); return
      }
      windows[model] = value
    }
    let settings = { ...draft, ...(provider === 'codex' ? { contextWindows: windows } : {}) }
    const request = ++generation.current
    setBusy(true)
    setError('')
    let savedEfforts = 0
    try {
      for (const model of catalog?.models ?? []) {
        const effort = efforts[model.id] ?? ''
        if (effort === (model.configured ?? '') || !model.efforts?.length) continue
        await callSubscriptionsAuth(rpc, 'setModelDefault', { provider, model: model.id, ...(effort ? { effort } : {}) })
        savedEfforts++
        if (generation.current === request) setCatalog(current => current && ({
          ...current, models: current.models.map(row => {
            if (row.id !== model.id) return row
            const { configured: _previous, ...rest } = row
            return { ...rest, ...(effort ? { configured: effort } : {}) }
          }),
        }))
      }
      // Account management can save while this editor has an older draft.
      // Refresh immediately before replacing settings, never revive stale accounts.
      const latest = await callSubscriptionsAuth<Catalog>(rpc, 'providerSettings', { provider })
      settings = mergeLatestAccounts(settings, latest.settings)
      await callSubscriptionsAuth(rpc, 'setProviderSettings', { provider, settings })
      if (generation.current !== request) return
      setDraft(settings)
      setCatalog(current => current && ({ ...current, settings }))
      setDirty(false)
      setSaved(true)
    } catch (error) {
      if (generation.current === request) setError((savedEfforts ? t('modelsPartialSave') + ' ' : '') + String(error instanceof Error ? error.message : error))
    } finally {
      if (generation.current === request) setBusy(false)
    }
  }
  const allModels = catalog?.models ?? []
  const known = new Set(allModels.map(model => model.id))
  const missing = (draft.visibleModels ?? []).filter(id => !known.has(id)).map(id => ({ id, name: id } as ModelRow))
  const models = [...allModels, ...missing].filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  const selected = new Set(draft.visibleModels ?? allModels.map(model => model.id))
  return <div style={{ borderTop: border, marginTop: 12, paddingTop: 12 }}>
    {embedded ? <h3 style={{ margin: 0, fontSize: 15 }}>{t('modelsEdit')}</h3> : <button type="button" style={{ ...control, border: 0, padding: 0, cursor: 'pointer' }} aria-expanded={open}
      onClick={() => { setOpen(!open); if (!open && !busy && !dirty) void load() }}>
      {t('modelsEdit')} {open ? '▴' : '▾'}
    </button>}
    {open && <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      <p style={{ margin: 0 }}>{t('modelsHint')}</p>
      {error && <p role="alert" style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary, #b42318)' }}>{error}</p>}
      {saved && <p role="status" style={{ margin: 0 }}>{t('modelsSaved')}</p>}
      <div style={actions}>
        <button type="button" style={control} disabled={busy || dirty} onClick={() => { void load(true) }}>{t('usageRefresh')}</button>
        {busy && <span role="status">{t('modelDefaultsLoading')}</span>}
      </div>
      {catalog && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 12 }}>
        <label><input type="checkbox" checked={draft.visibleModels === undefined} onChange={event => {
          const next = { ...draft }
          if (event.target.checked) delete next.visibleModels
          else next.visibleModels = allModels.map(model => model.id)
          edit(next)
        }} /> {t('modelsAutomatic')}</label>
        <div style={actions}>
          <input style={{ ...control, flex: '1 1 180px' }} value={query} onChange={event => setQuery(event.target.value)}
            placeholder={t('modelDefaultsFilterPlaceholder')} aria-label={t('modelDefaultsFilterPlaceholder')} />
          <button type="button" style={control} onClick={() => edit({ ...draft, visibleModels: allModels.map(model => model.id) })}>{t('modelsSelectAll')}</button>
          <button type="button" style={control} onClick={() => edit({ ...draft, visibleModels: [] })}>{t('modelsSelectNone')}</button>
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'grid', gap: 8 }}>
          {models.map(model => <div key={model.id} style={{ borderBottom: border, padding: '8px 2px', display: 'grid', gap: 8 }}>
            <label style={{ overflowWrap: 'anywhere' }}><input type="checkbox" checked={selected.has(model.id)} onChange={event => {
              const next = new Set(selected)
              if (event.target.checked) next.add(model.id); else next.delete(model.id)
              edit({ ...draft, visibleModels: [...next] })
            }} /> {model.name}{!known.has(model.id) && ` (${t('modelsUnavailable')})`}</label>
            <div style={actions}>
            {(model.efforts?.length ?? 0) > 0 && <label style={actions}>{t('modelDefaultsTitle')}
              <select style={control} aria-label={`${model.name} ${t('modelDefaultsTitle')}`}
                value={efforts[model.id] ?? ''} onChange={event => {
                  setEfforts({ ...efforts, [model.id]: event.target.value }); setDirty(true); setSaved(false)
                }}>
                <option value="">{t('modelDefaultsFollowProvider')}</option>
                {model.configured && !model.efforts?.some(effort => effort.id === model.configured) &&
                  <option value={model.configured} disabled>{model.configured} ({t('modelsUnavailable')})</option>}
                {model.efforts?.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
              </select>
            </label>}
            {provider === 'codex' && model.maxContextWindow !== undefined && <div style={actions}>
              <label style={actions}>{t('modelsContext')}
                <input style={{ ...control, width: 140 }} inputMode="numeric" value={contexts[model.id] ?? ''}
                  aria-label={`${model.name} ${t('modelsContext')}`} placeholder={String(model.defaultContextWindow)}
                  onChange={event => { setContexts({ ...contexts, [model.id]: event.target.value }); setDirty(true); setSaved(false) }} />
              </label>
              <small>{t('modelsContextBounds', { default: model.defaultContextWindow, max: model.maxContextWindow })}</small>
            </div>}
            </div>
          </div>)}
          {models.length === 0 && <span>{t('modelDefaultsFilterEmpty', { query })}</span>}
        </div>
        {provider === 'codex' && <small>{t('modelsContextHint')}</small>}
        {catalog.tools.length > 0 && <div style={{ display: 'grid', gap: 8 }}>
          <strong>{t('modelsTools')}</strong>
          <small>{t('modelsToolsHint')}</small>
          {catalog.tools.map(tool => <label key={tool}>
            <input type="checkbox" checked={draft.tools?.[tool] !== false} onChange={event => edit({
              ...draft, tools: { ...draft.tools, [tool]: event.target.checked },
            })} /> {t(tool === 'image_generate' ? 'modelsImage' : tool === 'video_generate' ? 'modelsVideo' : tool === 'web_search' ? 'modelsWebSearch' : 'modelsSearch')}
          </label>)}
        </div>}
        <div style={actions}>
          <button type="button" style={control} disabled={!dirty} onClick={() => { void save() }}>{t('modelsSave')}</button>
          <button type="button" style={control} disabled={!dirty} onClick={() => { reset(catalog); setError(''); setSaved(false) }}>{t('cancel')}</button>
        </div>
      </fieldset>}
    </div>}
  </div>
}
