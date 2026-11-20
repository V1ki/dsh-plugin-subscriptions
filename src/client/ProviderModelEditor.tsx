import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderPreferences, SubagentSpeedTier, SubscriptionTool } from '../provider-settings.js'
import type { SubscriptionProvider } from './SubscriptionsSection.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import type { AccountCatalogRow } from './account-preferences.js'
import { modelEditorState, savedModelIds } from './model-filter.js'
import type { SubscriptionsKey } from './locales.js'
import { SettingHelp } from './SettingHelp.js'

interface ModelRow {
  id: string
  name: string
  contextWindow?: number
  defaultContextWindow?: number
  efforts?: { id: string; name: string }[]
  configured?: string
  maxContextWindow?: number
  fastTier?: boolean
}
interface Catalog {
  provider: SubscriptionProvider
  settings: ProviderPreferences
  models: ModelRow[]
  /** One row per connected account; `unavailable` means its discovery failed. */
  accounts: AccountCatalogRow[]
  tools: SubscriptionTool[]
}
interface Props {
  provider: SubscriptionProvider
  rpc: ConnectionHandle['rpc']
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
  /** Freeze the editor while the owning dialog submits. */
  disabled?: boolean
  /** Reports whether the draft differs from the loaded catalog. */
  onDirtyChange?: (dirty: boolean) => void
}

/** The editor's unsaved edits, collected by the owning dialog's single Save. */
export interface ModelDraft {
  /** Provider settings minus `accounts`; absent when the draft has no edits. */
  settings?: ProviderPreferences
  /** Reasoning-effort overrides that differ from the catalog; '' clears one. */
  efforts: { model: string; effort: string }[]
}
export interface ProviderModelEditorHandle {
  /**
   * Validate and collect the draft without mutating it, so a failed submit
   * keeps every edit. Returns undefined when a value is invalid; the editor
   * shows the reason itself.
   */
  collect(): ModelDraft | undefined
}

const border = '0.5px solid var(--dsw-alias-border-l2, #ddd)'
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }

/** Decorative symbols complement the existing translated labels. */
function ToolIcon({ tool }: { tool: SubscriptionTool }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto', marginTop: 2 }}>
    {tool === 'image_generate' ? <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m4 18 5-5 3 3 3-4 5 6" /></>
      : tool === 'video_generate' ? <><rect x="3" y="5" width="13" height="14" rx="2" /><path d="m16 10 5-3v10l-5-3z" /></>
      : tool === 'web_search' ? <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>
      : <><path d="M5 4 19 20M19 4 5 20" /><circle cx="18" cy="18" r="3" /><path d="m20.2 20.2 1.8 1.8" /></>}
  </svg>
}

/**
 * Embedded section of the account manager dialog. It owns the model draft
 * (visibility, effort, context, tools) but not its submission: the dialog
 * collects the draft through the handle and saves it with the account edits
 * in one go, so there is a single Save/Cancel pair.
 */
export const ProviderModelEditor = forwardRef<ProviderModelEditorHandle, Props>(function ProviderModelEditor(
  { provider, rpc, t, disabled = false, onDirtyChange }, ref,
) {
  const [catalog, setCatalog] = useState<Catalog>()
  const [draft, setDraft] = useState<ProviderPreferences>({})
  const [contexts, setContexts] = useState<Record<string, string>>({})
  const [efforts, setEfforts] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [revealedInvalidModel, setRevealedInvalidModel] = useState<string>()
  const [editingName, setEditingName] = useState<string>()
  const idPrefix = useId()
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty])

  function reset(data: Catalog) {
    setCatalog(data)
    setExpanded(new Set())
    setRevealedInvalidModel(undefined)
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
  function edit(next: ProviderPreferences) { setDraft(next); setDirty(true) }
  useEffect(() => { void load() }, [provider, rpc])

  useImperativeHandle(ref, () => ({
    collect() {
      if (!catalog || !dirty) return { efforts: [] }
      const windows: Record<string, number> = Object.create(null) as Record<string, number>
      for (const [model, text] of Object.entries(contexts)) {
        if (!text.trim()) continue
        const value = Number(text)
        if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value <= 0) {
          setExpanded(previous => new Set(previous).add(model))
          setRevealedInvalidModel(model)
          setError(t('modelsContextInvalid', { model }))
          return undefined
        }
        windows[model] = value
      }
      setError('')
      setRevealedInvalidModel(undefined)
      const { accounts: _accounts, ...settings } = { ...draft, ...(provider === 'codex' ? { contextWindows: windows } : {}) }
      return {
        settings,
        efforts: catalog.models.flatMap(model => {
          const effort = efforts[model.id] ?? ''
          return effort === (model.configured ?? '') || !model.efforts?.length ? [] : [{ model: model.id, effort }]
        }),
      }
    },
  }), [catalog, dirty, draft, contexts, efforts, provider])

  const allModels = catalog?.models ?? []
  const known = new Set(allModels.map(model => model.id))
  const savedIds = savedModelIds(draft.visibleModels, draft.modelDisplayNames, draft.subagentSpeeds)
  const missing = savedIds.filter(id => !known.has(id)).map(id => ({ id, name: id } as ModelRow))
  const customName = (id: string) => Object.hasOwn(draft.modelDisplayNames ?? {}, id) ? draft.modelDisplayNames![id] : ''
  const editName = (id: string, value: string) => {
    const names: Record<string, string> = Object.assign(Object.create(null), draft.modelDisplayNames)
    if (value.trim()) names[id] = value
    else delete names[id]
    edit({ ...draft, modelDisplayNames: names })
  }
  const displayName = (model: ModelRow) => customName(model.id).trim() || model.name
  const models = [...allModels, ...missing]
    .filter(model => model.id === editingName || model.id === revealedInvalidModel || `${model.name} ${model.id} ${customName(model.id)}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => displayName(b).localeCompare(displayName(a), undefined, { sensitivity: 'base', numeric: true }) || b.id.localeCompare(a.id))
  const editorState = modelEditorState({
    discovered: allModels.length,
    saved: missing.length,
    matched: models.length,
    accounts: catalog?.accounts ?? [],
  })
  const selected = new Set(draft.visibleModels ?? allModels.map(model => model.id))
  const modelDescriptionId = (id: string) => idPrefix + '-model-id-' + Array.from({ length: id.length }, (_, i) => id.charCodeAt(i).toString(16).padStart(4, '0')).join('')
  return <div style={{ borderTop: border, marginTop: 12, paddingTop: 12 }}>
    <div style={{ ...actions, gap: 4 }}>
      <h3 style={{ margin: 0 }}>{t('modelsEdit')}</h3>
      <SettingHelp title={t('modelsEdit')} hint={t('modelsHint')} t={t} portal={false} />
      <button type="button" className="dsh-subscription-quiet" style={{ gap: 6, marginLeft: 'auto' }}
        disabled={busy || disabled || dirty} onClick={() => { void load(true) }}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2" />
        </svg>
        {t('usageRefresh')}
      </button>
      {busy && <span role="status">{t('modelDefaultsLoading')}</span>}
    </div>
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      {error && <p role="alert">{error}</p>}
      {catalog && <fieldset disabled={busy || disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 12 }}>
        <label><input type="checkbox" checked={draft.visibleModels === undefined} onChange={event => {
          const next = { ...draft }
          if (event.target.checked) delete next.visibleModels
          else next.visibleModels = allModels.map(model => model.id)
          edit(next)
        }} /> {t('modelsAutomatic')}</label>
        {editorState.listState === 'provider-empty' ? <p className="dsh-subscription-hint">{t(editorState.noticeKey)}</p> : <>
        <div style={actions}>
          <input style={{ flex: '1 1 180px' }} value={query} onChange={event => { setQuery(event.target.value); setRevealedInvalidModel(undefined) }}
            placeholder={t('modelDefaultsFilterPlaceholder')} aria-label={t('modelDefaultsFilterPlaceholder')} />
          <button type="button" onClick={() => edit({ ...draft, visibleModels: allModels.map(model => model.id) })}>{t('modelsSelectAll')}</button>
          <button type="button" onClick={() => edit({ ...draft, visibleModels: [] })}>{t('modelsSelectNone')}</button>
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'grid', gap: 0, alignContent: 'start' }}>
          {models.map(model => <div key={model.id} style={{ borderBottom: expanded.has(model.id) ? border : 'none', padding: expanded.has(model.id) ? '2px 2px 10px' : '2px', display: 'grid', gap: expanded.has(model.id) ? 8 : 0 }}>
            <div style={{ ...actions, flexWrap: 'nowrap', minWidth: 0 }}>
              <input type="checkbox" aria-describedby={modelDescriptionId(model.id)} aria-label={`${displayName(model)}${!known.has(model.id) ? ` (${t('modelsUnavailable')})` : ''}`} checked={selected.has(model.id)} onChange={event => {
                const next = new Set(selected)
                if (event.target.checked) next.add(model.id); else next.delete(model.id)
                edit({ ...draft, visibleModels: [...next] })
              }} />
              <button type="button" aria-labelledby={modelDescriptionId(model.id) + '-name'} aria-describedby={modelDescriptionId(model.id)} aria-expanded={expanded.has(model.id)} onClick={() => setExpanded(previous => {
                const next = new Set(previous)
                if (next.has(model.id)) next.delete(model.id); else next.add(model.id)
                return next
              })} className="dsh-subscription-model-toggle">
                <span className="dsh-subscription-model-name" id={modelDescriptionId(model.id) + '-name'}>{displayName(model)}{!known.has(model.id) && ` (${t('modelsUnavailable')})`}</span>
                <span className="dsh-subscription-model-id" id={modelDescriptionId(model.id)}>ID: {model.id}</span>
                <span className="dsh-subscription-model-action" aria-hidden="true">{t(expanded.has(model.id) ? 'modelsCollapse' : 'modelsExpand')}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={expanded.has(model.id) ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} /></svg>
                </span>
              </button>
            </div>
            {expanded.has(model.id) && <>
            <div style={actions}>
              <label style={{ display: 'grid', gap: 6, flex: '1 1 200px', minWidth: 0 }}>
                <span style={{ fontSize: 12 }}>{t('modelDisplayName')}</span>
                <input maxLength={80} aria-label={`${model.name} ${t('modelDisplayName')}`}
                  placeholder={model.name} value={customName(model.id)}
                  onFocus={() => setEditingName(model.id)} onBlur={() => setEditingName(undefined)}
                  onChange={event => editName(model.id, event.target.value)} />
              </label>
              <button type="button" style={{ alignSelf: 'end' }}
                aria-label={`${model.name} ${t('displayNameReset')}`} disabled={!customName(model.id)}
                onClick={() => editName(model.id, '')}>{t('displayNameReset')}</button>
            </div>
            <small style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{t('modelDisplayNameHint')}</small>
            <div style={actions}>
            {(model.efforts?.length ?? 0) > 0 && <label style={actions}>{t('modelDefaultsTitle')}
              <select aria-label={`${model.name} ${t('modelDefaultsTitle')}`}
                value={efforts[model.id] ?? ''} onChange={event => {
                  setEfforts({ ...efforts, [model.id]: event.target.value }); setDirty(true)
                }}>
                <option value="">{t('modelDefaultsFollowProvider')}</option>
                {model.configured && !model.efforts?.some(effort => effort.id === model.configured) &&
                  <option value={model.configured} disabled>{model.configured} ({t('modelsUnavailable')})</option>}
                {model.efforts?.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
              </select>
            </label>}
            {provider === 'codex' && model.maxContextWindow !== undefined && <div style={actions}>
              <label style={actions}>{t('modelsContext')}
                <input style={{ width: 140 }} inputMode="numeric" value={contexts[model.id] ?? ''}
                  aria-label={`${model.name} ${t('modelsContext')}`} placeholder={String(model.defaultContextWindow)}
                  onChange={event => { setContexts({ ...contexts, [model.id]: event.target.value }); setDirty(true) }} />
              </label>
              <small>{t('modelsContextBounds', { default: model.defaultContextWindow, max: model.maxContextWindow })}</small>
            </div>}
            </div>
            {provider === 'codex' && (model.fastTier || Object.hasOwn(draft.subagentSpeeds ?? {}, model.id)) && <div style={{ display: 'grid', gap: 6 }}>
              <div style={actions}>
                <label style={actions}>{t('modelsSubagentSpeed')}
                <select aria-label={`${model.name} ${t('modelsSubagentSpeed')}`}
                  value={Object.hasOwn(draft.subagentSpeeds ?? {}, model.id) ? draft.subagentSpeeds![model.id] : 'standard'}
                  onChange={event => edit({ ...draft, subagentSpeeds: {
                    ...draft.subagentSpeeds, [model.id]: event.target.value as SubagentSpeedTier,
                  } })}>
                  <option value="standard">{t('speedStandard')}</option>
                  <option value="fast" disabled={!model.fastTier}>{t('speedFast')}{!model.fastTier && ` (${t('modelsUnavailable')})`}</option>
                </select>
                </label>
                <SettingHelp title={`${model.name} ${t('modelsSubagentSpeed')}`} hint={t('modelsSubagentSpeedHint')} t={t} portal={false} />
              </div>
            </div>}
            </>}
          </div>)}
          {models.length === 0 && <span>{t('modelDefaultsFilterEmpty', { query })}</span>}
        </div>
        </>}
        {provider === 'codex' && <small>{t('modelsContextHint')}</small>}
        {catalog.tools.length > 0 && <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <strong>{t('modelsTools')}</strong>
            <SettingHelp title={t('modelsTools')} hint={t('modelsToolsHint')} t={t} portal={false} />
          </div>
          <div className="dsh-subscription-tools">
            {catalog.tools.map(tool => <label key={tool}>
              <ToolIcon tool={tool} />
              <span>{t(tool === 'image_generate' ? 'modelsImage' : tool === 'video_generate' ? 'modelsVideo' : tool === 'web_search' ? 'modelsWebSearch' : 'modelsSearch')}</span>
              <input type="checkbox" checked={draft.tools?.[tool] !== false} onChange={event => edit({
                ...draft, tools: { ...draft.tools, [tool]: event.target.checked },
              })} />
            </label>)}
          </div>
        </div>}
      </fieldset>}
    </div>
  </div>
})
