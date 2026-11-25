import { readComposerDisplay, subscribeComposerDisplay } from './composer-display-preferences.js'

/** The web renderer exposes this slot anchor in DSH 0.2.3. If absent, do nothing.
 * Keep the native contribution mounted: /model and model state are independent of its visibility.
 */
export function installComposerPickerVisibility(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-subscriptions-composer-picker'
  style.textContent = '[data-composer-card]:has([data-subscriptions-model-slider-active="true"]) [data-slot="conversation.input.model"] { display: none !important; }'
  const update = () => {
    if (readComposerDisplay('picker') === 'hidden') document.head.append(style)
    else style.remove()
  }
  update()
  const unsubscribe = subscribeComposerDisplay(update)
  return () => {
    unsubscribe()
    style.remove()
  }
}
