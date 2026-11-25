import { useSyncExternalStore } from 'react'

export type ComposerControl = 'slider' | 'picker'
export type ComposerDisplay = 'shown' | 'hidden'
const keys: Record<ComposerControl, string> = {
  slider: 'dsh.subscriptions.composerModelSlider',
  picker: 'dsh.subscriptions.composerModelPicker',
}
const eventName = 'dsh:subscriptions:composer-display'

export function readComposerDisplay(control: ComposerControl): ComposerDisplay {
  if (typeof window === 'undefined') return 'shown'
  try {
    return window.localStorage.getItem(keys[control]) === 'hidden' ? 'hidden' : 'shown'
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    return 'shown'
  }
}

export function setComposerDisplay(control: ComposerControl, mode: ComposerDisplay): void {
  window.localStorage.setItem(keys[control], mode)
  window.dispatchEvent(new Event(eventName))
}

export function subscribeComposerDisplay(notify: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || Object.values(keys).includes(event.key)) notify()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(eventName, notify)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(eventName, notify)
  }
}

export function useComposerDisplay(control: ComposerControl): ComposerDisplay {
  return useSyncExternalStore(subscribeComposerDisplay, () => readComposerDisplay(control), () => 'shown')
}
