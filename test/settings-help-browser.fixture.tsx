import React from 'react'
import { createRoot } from 'react-dom/client'
import { UsageBadgeDisplaySetting } from '../src/client/UsageBadgeDisplaySetting.js'
import { en, zh } from '../src/client/locales.js'

const dictionary = location.search.includes('locale=zh') ? zh : en
createRoot(document.getElementById('root')!).render(<>
  <button>Before settings</button>
  <UsageBadgeDisplaySetting t={(key, params) => Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])} />
  <button>Outside settings</button>
</>)
