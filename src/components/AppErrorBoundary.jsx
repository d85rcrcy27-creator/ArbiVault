import React from 'react'

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('ArbiVault render error:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen bg-[#090A0F] text-[#e0e4f0] flex items-center justify-center p-6">
        <div className="w-full max-w-xl rounded border border-[#FF4D4D]/40 bg-[#0C0E16] p-6">
          <div className="font-mono text-sm font-bold uppercase tracking-wider text-[#FF4D4D]">ArbiVault render error</div>
          <p className="mt-3 text-sm text-[#8a90b0]">Login succeeded, but the application screen failed to render.</p>
          <pre className="mt-4 max-h-48 overflow-auto rounded bg-[#090A0F] p-3 whitespace-pre-wrap break-words font-mono text-xs text-[#e0e4f0]">{this.state.error?.message || String(this.state.error)}</pre>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 w-full rounded border border-[#00F0FF]/40 bg-[#00F0FF]/5 px-3 py-2 font-mono text-xs font-bold uppercase text-[#00F0FF]">Reload ArbiVault</button>
        </div>
      </div>
    )
  }
}
