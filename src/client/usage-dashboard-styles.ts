/**
 * Scoped stylesheet for the Usage Dashboard sidebar page.
 * The host loads a single client JS bundle, so keep CSS inline and scoped
 * to `.dsh-usage-dashboard`, deriving colors from `@deepseek-ai/dsh-client-ui-theme`
 * semantic tokens (which flip automatically under `body[data-ds-dark-theme]`).
 */
export const usageDashboardCss = `
.dsh-usage-dashboard {
  --dsh-heat-0: var(--dsw-alias-bg-layer-2, #eef1f5);
  --dsh-heat-1: #cde3ff;
  --dsh-heat-2: #8bc0ff;
  --dsh-heat-3: #4c8dff;
  --dsh-heat-4: #1f5eff;
  --dsh-tok-input: #3b82f6;
  --dsh-tok-output: #10b981;
  --dsh-tok-cache-read: #8b5cf6;
  --dsh-tok-cache-write: #f59e0b;
  --dsh-provider-codex: #10a37f;
  --dsh-provider-claude: #d97757;
  --dsh-provider-grok: #7c6cff;
  --dsh-provider-antigravity: #3b82f6;

  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color-scheme: light;
  padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) 28px 44px calc(28px + var(--dsh-frame-leading-clearance, 0px));
}
.dsh-usage-dashboard.dsh-usage-dashboard-embedded {
  height: auto;
  overflow: visible;
  background: transparent;
  padding: 0;
}
.dsh-subscriptions-page {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color-scheme: light;
  padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) 28px 44px calc(28px + var(--dsh-frame-leading-clearance, 0px));
}
body[data-ds-dark-theme] .dsh-subscriptions-page {
  color-scheme: dark;
}
.dsh-subscriptions-page *,
.dsh-subscriptions-page *::before,
.dsh-subscriptions-page *::after {
  box-sizing: border-box;
}
.dsh-subscriptions-page-inner {
  max-width: 1120px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.dsh-subscriptions-page-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 20px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  padding-bottom: 0;
}
.dsh-subscriptions-page-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.dsh-subscriptions-page-tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dsh-subscriptions-page-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px 11px;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -0.5px;
  border-radius: var(--dsw-radius-sm, 6px) var(--dsw-radius-sm, 6px) 0 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
}
.dsh-subscriptions-page-tab:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.08));
}
.dsh-subscriptions-page-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary));
}
.dsh-subscriptions-page-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b82f6));
  outline-offset: -2px;
}
.dsh-subscriptions-page-panel {
  min-width: 0;
}
.dsh-subscriptions-page .dsh-subscription-tabs-shell {
  --tabs-surface: var(--dsw-alias-bg-base);
}
.dsh-subscriptions-settings-embedded {
  width: 100%;
  max-width: none;
}
.dsh-subscriptions-settings-embedded .dsh-subscription-tabs-shell {
  margin-bottom: 0;
}
.dsh-subscriptions-settings-embedded .dsh-subscription-tabs-track {
  padding: 2px 2px 4px;
}
.dsh-subscriptions-embedded-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 20px;
  align-items: start;
  min-width: 0;
}
.dsh-subscriptions-embedded-main {
  min-width: 0;
}
.dsh-subscriptions-embedded-aside {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dsh-subscriptions-page .dsh-subscription-settings-card {
  border: 0.5px solid var(--dsw-alias-border-l2) !important;
  border-radius: var(--dsw-radius-xl, 16px) !important;
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1)) !important;
  padding: 16px 18px !important;
}
body[data-ds-dark-theme] .dsh-usage-dashboard {
  --dsh-heat-0: rgba(255, 255, 255, 0.055);
  --dsh-heat-1: #16335b;
  --dsh-heat-2: #1f4f94;
  --dsh-heat-3: #3374d6;
  --dsh-heat-4: #60a5fa;
  --dsh-tok-input: #60a5fa;
  --dsh-tok-output: #34d399;
  --dsh-tok-cache-read: #a78bfa;
  --dsh-tok-cache-write: #fbbf24;
  color-scheme: dark;
}
.dsh-usage-dashboard *,
.dsh-usage-dashboard *::before,
.dsh-usage-dashboard *::after {
  box-sizing: border-box;
}
.dsh-usage-container {
  max-width: 1120px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.dsh-usage-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 16px;
}
.dsh-usage-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh-usage-title {
  margin: 0;
  font-size: 22px;
  line-height: 30px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--dsw-alias-label-primary);
}
.dsh-usage-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-usage-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-usage-updated {
  font-size: 12px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  font-variant-numeric: tabular-nums;
  margin-right: 4px;
}
.dsh-usage-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.dsh-usage-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}
.dsh-usage-btn:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2));
}
.dsh-usage-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.dsh-usage-btn:focus-visible,
.dsh-usage-select:focus-visible,
.dsh-usage-pill:focus-visible,
.dsh-usage-heat-cell:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b82f6));
  outline-offset: 2px;
}
.dsh-usage-btn-danger {
  color: var(--dsw-alias-state-error-primary, #d92d20);
}
.dsh-usage-btn-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}

/* Filter Bar */
.dsh-usage-filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 12px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 16px);
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
}
.dsh-usage-filter-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.dsh-usage-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border: 0.5px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-usage-pill:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}
.dsh-usage-pill[aria-pressed="true"] {
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.dsh-usage-pill-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 400;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-usage-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  align-self: center;
}
.dsh-usage-segmented {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  min-height: 36px;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  gap: 2px;
}
.dsh-usage-segmented-compact {
  min-height: 30px;
  padding: 2px;
  border-radius: 8px;
}
.dsh-usage-segmented-compact .dsh-usage-pill {
  height: 24px;
  padding: 0 9px;
  border-radius: 6px;
}
.dsh-usage-select {
  min-width: 150px;
  max-width: 260px;
  height: 36px;
  padding: 0 28px 0 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
}
.dsh-usage-select option,
.dsh-usage-select optgroup {
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}

/* Banners */
.dsh-usage-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 14px;
  border-radius: var(--dsw-radius-lg, 12px);
  border: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 18px;
}
.dsh-usage-banner-error {
  background: rgba(217, 45, 32, 0.08);
  border-color: rgba(217, 45, 32, 0.3);
  color: var(--dsw-alias-state-error-primary, #d92d20);
}
.dsh-usage-banner-warn {
  background: var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.1));
  border-color: rgba(245, 158, 11, 0.3);
  color: var(--dsw-alias-label-primary);
}

/* Cards */
.dsh-usage-card {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 16px);
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dsh-usage-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-width: 0;
}
.dsh-usage-card-title {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-usage-card-subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* KPI Grid */
.dsh-usage-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.dsh-usage-kpi-card {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 16px);
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dsh-usage-kpi-label {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-weight: 500;
}
.dsh-usage-kpi-value {
  font-size: 24px;
  line-height: 30px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}
.dsh-usage-kpi-sub {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
}
.dsh-usage-split-bar {
  display: flex;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
  gap: 1px;
  margin-top: 2px;
}

/* Heatmap */
.dsh-usage-heatmap-body {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(260px, 1fr);
  gap: 18px 24px;
  align-items: start;
}
.dsh-usage-heatmap-scroll {
  overflow-x: auto;
  padding-bottom: 4px;
  max-width: 100%;
}
.dsh-usage-heatmap-inner {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-usage-heatmap-months {
  display: grid;
  grid-auto-flow: column;
  gap: 3px;
  padding-left: 30px;
  height: 16px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-usage-heatmap-month-label {
  white-space: nowrap;
  overflow: visible;
}
.dsh-usage-heatmap-matrix {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.dsh-usage-heatmap-weekdays {
  display: grid;
  grid-template-rows: repeat(7, 14px);
  gap: 3px;
  width: 24px;
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  text-align: right;
  user-select: none;
}
.dsh-usage-heatmap-weeks {
  display: flex;
  gap: 3px;
}
.dsh-usage-heatmap-col {
  display: grid;
  grid-template-rows: repeat(7, 14px);
  gap: 3px;
}
.dsh-usage-heat-cell {
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0.5px solid rgba(128, 128, 128, 0.14);
  border-radius: 3px;
  cursor: pointer;
  transition: transform 90ms ease, outline-color 90ms ease;
}
.dsh-usage-heat-cell:hover {
  transform: scale(1.16);
}
.dsh-usage-heat-cell[data-empty="true"] {
  visibility: hidden;
  pointer-events: none;
}
.dsh-usage-heat-cell[data-level="0"] { background: var(--dsh-heat-0); }
.dsh-usage-heat-cell[data-level="1"] { background: var(--dsh-heat-1); }
.dsh-usage-heat-cell[data-level="2"] { background: var(--dsh-heat-2); }
.dsh-usage-heat-cell[data-level="3"] { background: var(--dsh-heat-3); }
.dsh-usage-heat-cell[data-level="4"] { background: var(--dsh-heat-4); }
.dsh-usage-heat-cell[aria-pressed="true"] {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 1px;
}
.dsh-usage-heat-legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-usage-heat-swatch {
  width: 11px;
  height: 11px;
  border-radius: 2.5px;
  border: 0.5px solid rgba(128, 128, 128, 0.14);
}
.dsh-usage-day-inspector {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dsh-usage-day-inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-usage-day-models {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh-usage-day-model-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}
.dsh-usage-day-model-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}
.dsh-usage-day-model-val {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}

/* Charts Row */
.dsh-usage-charts-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
  gap: 16px;
}
.dsh-usage-legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-usage-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.dsh-usage-legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}
.dsh-usage-chart-wrap {
  position: relative;
  width: 100%;
  min-width: 0;
}
.dsh-usage-chart-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.dsh-usage-tooltip {
  position: absolute;
  top: 6px;
  z-index: 10;
  pointer-events: none;
  min-width: 175px;
  max-width: 240px;
  padding: 9px 11px;
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-tooltip-label, var(--dsw-alias-label-primary));
  border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.dsh-usage-tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

/* Distribution Bars */
.dsh-usage-dist-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-width: 0;
}
.dsh-usage-dist-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh-usage-dist-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.dsh-usage-dist-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-usage-dist-val {
  flex-shrink: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}
.dsh-usage-dist-track {
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
  display: flex;
}
.dsh-usage-dist-sub {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

/* Quota Cycles Dual-Axis Combo Chart */
.dsh-usage-cycle-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-usage-cycles-legend-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.dsh-usage-legend-line {
  display: inline-block;
  width: 14px;
  height: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-label-primary);
  opacity: 0.85;
  flex-shrink: 0;
}
.dsh-usage-legend-hollow {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-label-tertiary);
  background: transparent;
  flex-shrink: 0;
}
.dsh-usage-legend-active-bar {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  border: 1.5px solid var(--dsw-alias-state-success-primary, #10b981);
  background: rgba(16, 185, 129, 0.25);
  flex-shrink: 0;
}
.dsh-usage-active-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-usage-active-strip-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  margin-right: 2px;
  white-space: nowrap;
}
.dsh-usage-active-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  max-width: 100%;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}
.dsh-usage-active-pill:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
}
.dsh-usage-active-pill[aria-pressed="true"] {
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary));
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2));
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, transparent);
}
.dsh-usage-active-pill:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #3b82f6));
  outline-offset: 2px;
}
.dsh-usage-active-pill-kind {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
}
.dsh-usage-active-pill-tok {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.dsh-usage-active-pill-pct {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.dsh-usage-active-pill-pct[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #10b981); }
.dsh-usage-active-pill-pct[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #d97706); }
.dsh-usage-active-pill-pct[data-tone="danger"] { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-usage-active-pill-pct[data-tone="na"] { color: var(--dsw-alias-label-tertiary); font-weight: 400; }

.dsh-usage-combo-wrap {
  position: relative;
  width: 100%;
  min-width: 0;
}
.dsh-usage-combo-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

/* Inline Pinned Cycle Inspector */
.dsh-usage-cycle-inspector {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  padding: 13px 15px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dsh-usage-cycle-inspector-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 12px 20px;
  align-items: start;
}
.dsh-usage-cycle-inspector-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dsh-usage-window-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 8px;
  min-width: 0;
}
.dsh-usage-window-id {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 160px;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
}
.dsh-usage-window-provider {
  white-space: nowrap;
  flex-shrink: 0;
}
.dsh-usage-window-sep {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 400;
  flex-shrink: 0;
}
.dsh-usage-window-account {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.dsh-usage-window-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}
.dsh-usage-cycle-metrics {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.dsh-usage-cycle-metric-label {
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-usage-cycle-quota-col {
  text-align: right;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}
.dsh-usage-cycle-quota-val {
  font-size: 16px;
  line-height: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dsh-usage-cycle-quota-val[data-tone="ok"] {
  color: var(--dsw-alias-state-success-primary, #10b981);
}
.dsh-usage-cycle-quota-val[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-primary, #d97706);
}
.dsh-usage-cycle-quota-val[data-tone="danger"] {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.dsh-usage-cycle-quota-val[data-tone="na"] {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-usage-quota-track {
  position: relative;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  overflow: hidden;
}
.dsh-usage-quota-track[data-na="true"] {
  background: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 5px,
    rgba(128, 128, 128, 0.1) 5px,
    rgba(128, 128, 128, 0.1) 10px
  );
}
.dsh-usage-quota-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 180ms ease;
}
.dsh-usage-quota-fill[data-tone="ok"] {
  background: var(--dsw-alias-state-success-primary, #10b981);
}
.dsh-usage-quota-fill[data-tone="warn"] {
  background: var(--dsw-alias-state-warn-primary, #f59e0b);
}
.dsh-usage-quota-fill[data-tone="danger"] {
  background: var(--dsw-alias-state-error-primary, #ef4444);
}
.dsh-usage-quota-peak-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--dsw-alias-label-primary);
  opacity: 0.55;
}
.dsh-usage-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.dsh-usage-badge-open {
  color: var(--dsw-alias-state-success-primary, #10b981);
  border-color: rgba(16, 185, 129, 0.35);
}
.dsh-usage-badge-warn {
  color: var(--dsw-alias-state-warn-primary, #d97706);
  border-color: rgba(245, 158, 11, 0.35);
}
.dsh-usage-window-total {
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.dsh-usage-window-models {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.dsh-usage-model-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dsh-usage-markers {
  margin: 0;
  padding-left: 16px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}

/* Empty State */
.dsh-usage-empty {
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 16px);
  background: var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-1));
  padding: 36px 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.dsh-usage-empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-usage-empty-desc {
  margin: 0;
  max-width: 460px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

@media (max-width: 959px) {
  .dsh-usage-heatmap-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .dsh-usage-charts-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .dsh-usage-cycle-inspector-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .dsh-subscriptions-embedded-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 820px) {
  .dsh-usage-dashboard,
  .dsh-subscriptions-page {
    padding: calc(20px + var(--dsh-frame-top-clearance, 0px)) 16px 32px calc(16px + var(--dsh-frame-leading-clearance, 0px));
  }
  .dsh-usage-dashboard.dsh-usage-dashboard-embedded {
    padding: 0;
  }
  .dsh-usage-kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 500px) {
  .dsh-usage-kpi-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
`
