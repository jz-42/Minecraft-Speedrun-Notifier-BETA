import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const UMAMI_SRC = import.meta.env.VITE_UMAMI_SRC
const UMAMI_WEBSITE_ID = import.meta.env.VITE_UMAMI_WEBSITE_ID

if (UMAMI_SRC && UMAMI_WEBSITE_ID && typeof document !== 'undefined') {
  const existing = document.querySelector(`script[data-website-id="${UMAMI_WEBSITE_ID}"]`)
  if (!existing) {
    const script = document.createElement('script')
    script.defer = true
    script.src = UMAMI_SRC
    script.setAttribute('data-website-id', UMAMI_WEBSITE_ID)
    document.head.appendChild(script)
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
