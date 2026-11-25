export const modelSliderCss = `
.dsh-model-slider { position: relative; isolation: isolate; display: inline-flex; align-items: center; flex: none; gap: 3px; }
.dsh-model-slider-track { position: relative; width: 130px; }
.dsh-model-slider-fast {
  display: grid; place-items: center; width: 28px; height: 32px; padding: 0;
  border: 0; border-radius: 99px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #b8b8b8);
}
.dsh-model-slider-fast svg { fill: none; }
.dsh-model-slider-fast:hover { background: var(--dsw-alias-interactive-bg-hover, #494949); }
.dsh-model-slider-fast[aria-pressed="true"] { color: var(--dsw-alias-label-primary, #fff); }
.dsh-model-slider-fast[aria-pressed="true"] svg { fill: #a27af7; stroke: #a27af7; }
.dsh-model-slider-fast[aria-pressed="true"] path { stroke: inherit; }
.dsh-model-slider-fast[aria-disabled="true"] { cursor: progress; }
.dsh-model-slider-hit {
  position: relative; height: 32px; border-radius: 999px; cursor: pointer;
  user-select: none; touch-action: none;
}
.dsh-model-slider-hit[aria-busy="true"] { cursor: progress; }
.dsh-model-slider-hit:focus-visible, .dsh-model-slider-fast:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, Highlight); outline-offset: 0;
}
.dsh-model-slider-rail {
  position: absolute; top: 50%; inset-inline: 1px; height: 18px;
  transform: translateY(-50%); border-radius: 99px; pointer-events: none;
  background: var(--dsw-alias-interactive-bg-hover, #545454);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l3, #666);
}
/* Fill and thumb share the same axis. Only the fill extends under the rounded end caps. */
.dsh-model-slider-steps, .dsh-model-slider-progress {
  --cap: calc(var(--slider-inset) - 1px); --fill-start: calc(0px - var(--cap));
  position: absolute; inset: 0 var(--cap);
}
.dsh-model-slider-rail { overflow: hidden; }
.dsh-model-slider-fill {
  position: absolute; inset-block: 0; left: var(--fill-start);
  background: var(--dsw-alias-label-secondary, #bbb);
}
.dsh-model-slider-rail[data-premium="true"] .dsh-model-slider-fill {
  background: linear-gradient(100deg, #7099ff, #a27af7, #7446ee);
}
.dsh-model-slider-tick, .dsh-model-slider-thumb {
  position: absolute; top: 50%; transform: translate(-50%, -50%); border-radius: 50%;
}
.dsh-model-slider-tick { width: 6px; height: 6px; background: var(--dsw-alias-label-secondary, #bbb); }
.dsh-model-slider-tick[data-filled="true"] { background: var(--dsw-alias-bg-layer-2, #333); }
.dsh-model-slider-thumb {
  width: 18px; height: 18px; background: var(--dsw-alias-label-primary, #fff);
  box-shadow: 0 1px 4px #0005;
}
/* Animate the caption row, not a clip on the panel border: corners stay continuous. */
.dsh-model-slider-hint {
  position: absolute; z-index: -1; bottom: -2px; inset-inline: -5px;
  display: grid; grid-template-rows: 0fr; opacity: 0; pointer-events: none;
  padding: 0 7px 34px; border-radius: var(--dsw-radius-lg, 14px);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #303032));
  border: 1px solid var(--dsw-alias-border-l3, #48484b);
  transition: grid-template-rows 180ms ease-out, opacity 140ms ease-out;
}
.dsh-model-slider-caption {
  min-height: 0; overflow: hidden; text-align: center; overflow-wrap: anywhere;
  font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-primary, #fff);
}
.dsh-model-slider-caption > span { display: block; padding-top: 7px; }
.dsh-model-slider-caption small { display: block; white-space: pre-line; font-size: 10px; color: var(--dsw-alias-label-secondary, #bbb); }
.dsh-model-slider:is(:hover, :has(:focus-visible), [data-open="true"], [data-preview="true"], [data-failed="true"]) .dsh-model-slider-hint {
  opacity: 1; grid-template-rows: 1fr; pointer-events: auto;
}
.dsh-model-slider-providers {
  display: flex; justify-content: center; align-items: center; gap: 5px;
  padding: 4px 0 3px; border-bottom: 1px solid var(--dsw-alias-border-l3, #48484b);
  visibility: hidden;
}
.dsh-model-slider:is(:hover, :has(:focus-visible), [data-open="true"]) .dsh-model-slider-providers { visibility: visible; }
.dsh-model-slider-providers button {
  font: inherit; font-size: 11px; line-height: 18px; padding: 0 6px;
  border: 0; border-radius: 5px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #bbb);
}
.dsh-model-slider-providers button[aria-pressed="true"] { color: var(--dsw-alias-label-primary, #fff); font-weight: 600; }
.dsh-model-slider-providers button:hover { background: var(--dsw-alias-interactive-bg-hover, #494949); }
.dsh-model-slider-providers button + button { margin-inline-start: 4px; position: relative; }
.dsh-model-slider-providers button + button::before {
  content: ""; position: absolute; inset-inline-start: -5px; top: 4px; bottom: 4px; border-inline-start: 1px solid var(--dsw-alias-border-l3, #666);
}
.dsh-model-slider-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (prefers-reduced-motion: reduce) {
  .dsh-model-slider-hint { transition: none; }
}
`
