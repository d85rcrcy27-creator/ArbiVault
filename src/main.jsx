import React from 'react'
import ReactDOM from 'react-dom/client'
import '@/index.css'

const rootElement = document.getElementById('root')

function showStartupError(error) {
  if (!rootElement) return
  const message = error instanceof Error ? error.message : String(error)
  const safeMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  rootElement.innerHTML = `
    <div style="min-height:100vh;background:#090A0F;color:#e0e4f0;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif">
      <div style="width:100%;max-width:680px;border:1px solid rgba(255,77,77,.45);background:#0C0E16;border-radius:8px;padding:24px">
        <div style="font-family:monospace;font-size:13px;font-weight:700;letter-spacing:.08em;color:#FF4D4D;text-transform:uppercase">ArbiVault startup error</div>
        <p style="margin:12px 0;color:#8a90b0;font-size:14px">The application failed before React could render the login screen.</p>
        <pre style="white-space:pre-wrap;word-break:break-word;background:#090A0F;border-radius:6px;padding:14px;color:#e0e4f0;font:12px/1.5 ui-monospace,monospace">${safeMessage}</pre>
        <button onclick="location.reload()" style="margin-top:14px;width:100%;padding:10px 12px;background:#00F0FF;color:#090A0F;border:0;border-radius:6px;font-weight:700;cursor:pointer">Reload</button>
      </div>
    </div>
  `
}

if (!rootElement) {
  throw new Error('Root element not found')
}

window.addEventListener('error', (event) => {
  if (event?.error) showStartupError(event.error)
})
window.addEventListener('unhandledrejection', (event) => {
  if (event?.reason) showStartupError(event.reason)
})

import('./App.jsx')
  .then(({ default: App }) => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  })
  .catch(showStartupError)
