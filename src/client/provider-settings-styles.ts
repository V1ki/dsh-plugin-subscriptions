/**
 * The host loads one JS client bundle, so keep this small, scoped stylesheet
 * with the dialog instead of relying on a separate CSS asset. Geometry and
 * theme tokens follow the host's settings-form and ui-primitives controls.
 */
const formScope = ':is(.dsh-subscription-manager, .dsh-subscriptions-settings)'

export const providerSettingsCss = `
.dsh-subscription-manager {
  box-sizing: border-box;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent, 0 20px 70px #0004);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color-scheme: light;
}
.dsh-subscriptions-settings {
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color-scheme: light;
}
.dsh-subscription-provider-area { min-width: 0; }
.dsh-subscription-provider-header {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.dsh-subscription-provider-identity { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
.dsh-subscription-provider-actions,
.dsh-subscription-add-account {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-subscription-provider-actions { margin-left: auto; }
.dsh-subscription-add-account { gap: 2px; }
.dsh-subscription-provider-actions button { gap: 5px; }
.dsh-subscription-tabs-shell {
  position: relative;
  min-width: 0;
  margin-bottom: 4px;
  --tabs-surface: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, Canvas));
}
.dsh-subscription-tabs {
  overflow-x: auto;
  scrollbar-width: none;
}
.dsh-subscription-tabs::-webkit-scrollbar { display: none; }
.dsh-subscription-tabs-track {
  display: flex;
  width: max-content;
  gap: 6px;
  padding: 4px 4px 10px;
}
.dsh-subscription-tabs-shell::before,
.dsh-subscription-tabs-shell::after {
  position: absolute;
  z-index: 1;
  top: 4px;
  bottom: 10px;
  width: 44px;
  content: '';
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
}
.dsh-subscription-tabs-shell::before {
  left: 0;
  background: linear-gradient(to right, var(--tabs-surface) 24px, transparent);
}
.dsh-subscription-tabs-shell::after {
  right: 0;
  background: linear-gradient(to left, var(--tabs-surface) 24px, transparent);
}
.dsh-subscription-tabs-shell[data-left]::before,
.dsh-subscription-tabs-shell[data-right]::after { opacity: 1; }
${formScope} button.dsh-subscription-tabs-arrow {
  position: absolute;
  z-index: 2;
  top: 6px;
  width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2, #8884);
  border-radius: 9px;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--tabs-surface);
  box-shadow: 0 1px 3px #0002;
  transition: opacity 120ms ease, visibility 120ms;
}
${formScope} button.dsh-subscription-tabs-arrow-left { left: 0; }
${formScope} button.dsh-subscription-tabs-arrow-right { right: 0; }
${formScope} button.dsh-subscription-tabs-arrow:disabled {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
${formScope} .dsh-subscription-tabs button {
  gap: 6px;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
${formScope} .dsh-subscription-tabs button:focus-visible { outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) {
  .dsh-subscription-tabs-shell::before,
  .dsh-subscription-tabs-shell::after,
  ${formScope} button.dsh-subscription-tabs-arrow,
  ${formScope} .dsh-subscription-tabs button { transition: none; }
}
${formScope} .dsh-subscription-tabs button[aria-selected="true"] {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-3));
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
body[data-ds-dark-theme] ${formScope} {
  color-scheme: dark;
}
.dsh-subscription-manager::backdrop {
  background: var(--dsw-alias-bg-mask-1, #0006);
  backdrop-filter: var(--dsw-mask-blur, none);
}
${formScope} h2 {
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}
${formScope} h3 {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
}
${formScope} strong,
${formScope} .dsh-subscription-label {
  font-size: 13px;
  line-height: 1.5;
  font-weight: 500;
}
${formScope} legend {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
}
${formScope} small,
${formScope} .dsh-subscription-hint,
${formScope} [role="status"] {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
${formScope} [role="alert"] {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary, #b42318);
}
${formScope} input:not([type="checkbox"]),
${formScope} select {
  box-sizing: border-box;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
}
${formScope} input::placeholder {
  color: var(--dsw-alias-label-tertiary);
  opacity: 1;
}
${formScope} input:not([type="checkbox"]):focus-visible,
${formScope} select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
${formScope} input:not([type="checkbox"]):disabled,
${formScope} select:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
${formScope} input[aria-invalid="true"] {
  border-color: var(--dsw-alias-state-error-primary, #b42318);
}
${formScope} option {
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
}
${formScope} label:has(> input[type="checkbox"]) {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;
}
${formScope} input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 2px 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: inherit;
}
${formScope} label:has(> input[type="checkbox"]:disabled) {
  cursor: default;
  opacity: 0.5;
}
${formScope} button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
${formScope} button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3));
}
${formScope} button:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-3));
}
${formScope} button:disabled {
  opacity: 0.4;
  cursor: default;
}
${formScope} button.dsh-subscription-setting-help {
  min-height: 24px;
  width: 24px;
  padding: 4px;
  border: 0;
  border-radius: 50%;
  color: var(--dsw-alias-label-tertiary);
}
${formScope} button.dsh-subscription-setting-help:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  outline-offset: 2px;
}

${formScope} button.dsh-subscription-model-toggle {
  flex: 1 1 0;
  min-width: 0;
  justify-content: flex-start;
  gap: 6px;
  padding: 4px 6px;
  border: 0;
  text-align: left;
  overflow-wrap: anywhere;
  font-size: 13px;
}
.dsh-subscription-model-name { min-width: 0; overflow-wrap: anywhere; }
.dsh-subscription-model-id {
  min-width: 0;
  padding-left: 6px;
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-subscription-model-action {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: 12px;
}
.dsh-subscription-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  min-width: 0;
}
.dsh-subscription-tools label { min-width: 0; overflow-wrap: anywhere; }

${formScope} button.dsh-subscription-quiet {
  border-color: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
}
${formScope} :is(footer, .dsh-subscription-dialog-actions) button {
  min-height: 34px;
  padding: 0 14px;
  border-radius: var(--dsw-radius-md, 8px);
  font-size: 13px;
  line-height: 1.5;
}
${formScope} button.dsh-subscription-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1));
  font-weight: 500;
}
${formScope} button.dsh-subscription-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-secondary));
}
${formScope} button:focus-visible,
${formScope} input[type="checkbox"]:focus-visible,
${formScope} summary:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
${formScope} summary {
  border-radius: var(--dsw-radius-sm, 6px);
}
${formScope} summary:hover {
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
}
`

/** Composer controls retain their own geometry, separate from settings forms. */
export const subscriptionChromeCss = `
.dsh-subscription-usage-pill { corner-shape: round; }
.dsh-subscription-usage-panel {
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
}
.dsh-subscription-speed button:hover:not(:disabled) {
  --dsh-subscription-speed-hover: var(--dsw-alias-interactive-bg-hover);
}
.dsh-subscription-speed button:active:not(:disabled) {
  --dsh-subscription-speed-hover: var(--dsw-alias-interactive-bg-active);
}
.dsh-subscription-speed button:disabled { opacity: 0.4; cursor: default; }
.dsh-subscription-speed button:focus-visible,
.dsh-subscription-usage-pill:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
`
