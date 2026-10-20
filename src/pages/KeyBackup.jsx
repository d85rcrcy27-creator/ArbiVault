import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, ClipboardCheck, Download, KeyRound, ShieldAlert } from 'lucide-react'

const CHECKLIST = [
  'Confirm you know which key is being backed up and what it controls.',
  'Use only the official wallet or custody provider recovery flow on a trusted device.',
  'Store recovery material offline in a private, physically secure location.',
  'Never paste private keys, seed phrases, recovery codes or signing secrets into this website, chat, a support ticket or a cloud document.',
  'Verify recovery using the provider’s documented process before relying on the backup.',
  'Keep a separate record of the public wallet address and network; public addresses are not secret keys.',
]

export default function KeyBackup() {
  const [checked, setChecked] = useState([])
  const [notice, setNotice] = useState('')
  const completed = checked.length === CHECKLIST.length

  function downloadChecklist() {
    const payload = {
      title: 'ArbiVault key backup checklist',
      created_at: new Date().toISOString(),
      note: 'Checklist only. This file contains no keys, seed phrases, passwords or recovery codes.',
      checklist: CHECKLIST.map((item, index) => ({ item, completed: checked.includes(index) })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'arbivault-key-backup-checklist.json'
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice('Downloaded checklist only. No key material was exported.')
  }

  return (
    <main className="min-h-screen bg-[#090A0F] px-4 py-6 text-[#e0e4f0] sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <Link to="/" className="inline-flex items-center gap-2 font-mono text-xs text-[#8a90b0] hover:text-[#00F0FF]"><ArrowLeft size={14} /> BACK TO ARBIVAULT</Link>
        <header className="border-b border-[#232738] pb-5"><p className="font-mono text-[10px] uppercase tracking-[.22em] text-[#00F0FF]">Custody safety</p><h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Wallet Key Backup</h1><p className="mt-2 text-sm text-[#8a90b0]">A guided checklist for safely preparing and validating a wallet recovery plan.</p></header>

        <div role="alert" className="flex gap-3 rounded border border-amber-500/40 bg-amber-950/20 p-4"><ShieldAlert className="mt-0.5 shrink-0 text-[#FFB800]" size={20} /><div><h2 className="text-sm font-semibold text-[#FFB800]">This page never handles private keys</h2><p className="mt-1 text-sm leading-6 text-[#c4c8d8]">ArbiVault browser code must not export server-side signing keys or expose encryption secrets. This helper downloads only a checklist. Use the official custody provider’s authenticated recovery or key-rotation workflow for key material.</p></div></div>

        <section className="rounded border border-[#232738] bg-[#0C0E16] p-5"><div className="mb-4 flex items-center gap-2"><KeyRound className="text-[#00F0FF]" size={18} /><h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Backup preparation</h2></div><div className="space-y-4">{CHECKLIST.map((item, index) => <label key={item} className="flex cursor-pointer gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 h-4 w-4 accent-cyan-400" checked={checked.includes(index)} onChange={(event) => setChecked((current) => event.target.checked ? [...current, index] : current.filter((n) => n !== index))} /><span className={checked.includes(index) ? 'text-[#8a90b0]' : 'text-[#e0e4f0]'}>{item}</span></label>)}</div><div className="mt-5 border-t border-[#232738] pt-4"><div className="mb-3 flex items-center gap-2 text-xs text-[#8a90b0]"><ClipboardCheck size={15} /> {checked.length} of {CHECKLIST.length} steps checked</div><div className="h-1.5 overflow-hidden rounded bg-[#232738]"><div className="h-full bg-[#00F0FF] transition-all" style={{ width: (checked.length / CHECKLIST.length * 100) + '%' }} /></div><button onClick={downloadChecklist} className="mt-4 inline-flex items-center gap-2 rounded border border-[#30364b] px-4 py-2 font-mono text-xs hover:border-[#00F0FF]"><Download size={14} /> DOWNLOAD CHECKLIST</button>{notice && <p role="status" className="mt-3 text-xs text-[#00FF87]">{notice}</p>}{completed && <p className="mt-3 flex items-center gap-2 text-sm text-[#00FF87]"><CheckCircle2 size={16} /> Checklist completed. This does not verify that a backup exists or is recoverable.</p>}</div></section>

        <section className="rounded border border-[#232738] bg-[#0C0E16] p-5"><h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Recovery and import</h2><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-[#c4c8d8]"><li>Open the official custody provider using a trusted bookmark and authenticate.</li><li>Use its documented recovery, restore, or key-rotation procedure. Do not import a signing key into ArbiVault’s browser UI.</li><li>After restoration, compare the resulting public address and network with the independently verified wallet record.</li><li>Perform a read-only balance and transaction-history check before enabling trading.</li><li>If a key may have been exposed, treat it as compromised and follow the provider’s rotation and fund-migration procedure.</li></ol><p className="mt-4 text-xs leading-5 text-[#5a6080]">ArbiVault currently keeps signing secrets on the server side. This page does not implement private-key import/export because doing so in the browser would violate that custody boundary.</p></section>
      </div>
    </main>
  )
}
