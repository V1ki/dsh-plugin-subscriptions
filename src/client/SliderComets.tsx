import type { CSSProperties } from 'react'

// Fixed phases keep the field scattered on first paint and across slider rerenders.
const comets = [
  { y: 18, phase: .73, size: 1.2, tail: 3, light: .52, seconds: 7.1 },
  { y: 64, phase: .14, size: 2.2, tail: 8, light: .95, seconds: 4.3 },
  { y: 39, phase: .92, size: 1.5, tail: 5, light: .68, seconds: 6.2 },
  { y: 77, phase: .49, size: 1,   tail: 2, light: .48, seconds: 7.9 },
  { y: 25, phase: .35, size: 2,   tail: 7, light: .86, seconds: 4.9 },
  { y: 55, phase: .61, size: 1.4, tail: 4, light: .62, seconds: 6.7 },
]

export function SliderComets() {
  return (
    <span className="dsh-model-slider-comets" aria-hidden="true">
      {comets.map(({ y, phase, size, tail, light, seconds }) => (
        <span key={y} className="dsh-model-slider-comet" style={{
          top: `${y}%`, width: size, height: size, opacity: light,
          '--tail': `${tail}px`, '--period': `${seconds}s`, '--phase': -phase,
        } as CSSProperties} />
      ))}
    </span>
  )
}

export const sliderCometCss = `
.dsh-model-slider-comets {
  position: absolute; inset: 0; overflow: hidden; border-radius: inherit; pointer-events: none;
  container-type: inline-size; opacity: .72; --pace: 1;
}
.dsh-model-slider[data-fast="true"] .dsh-model-slider-comets { opacity: .94; --pace: .39; }
.dsh-model-slider-comet {
  position: absolute; left: 0; border-radius: 50%; background: white;
  transform: translateX(calc((1 + var(--phase)) * 100cqw));
}
.dsh-model-slider-comet::after {
  content: ""; position: absolute; left: 65%; top: 24%; height: 52%; width: var(--tail);
  background: linear-gradient(to right, #fffc, transparent); border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .dsh-model-slider-rail[data-premium="true"] .dsh-model-slider-comet,
  .dsh-model-slider[data-fast="true"] .dsh-model-slider-comet {
    --duration: calc(var(--period) * var(--pace));
    animation: dsh-model-slider-comet-drift var(--duration) linear infinite;
    animation-delay: calc(var(--phase) * var(--duration));
  }
}
@keyframes dsh-model-slider-comet-drift {
  from { transform: translateX(100cqw); }
  to { transform: translateX(calc(-100% - var(--tail))); }
}
`
