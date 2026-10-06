import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/AuthContext'

export default function WalletBootstrap() {
  const [wallets,setWallets]=useState([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const { user, isLoading: authLoading } = useAuth()

  const load=async()=>{
    if(!user){setLoading(false);setError('Supabase auth session unavailable. Please sign in again.');return}
    setLoading(true)
    const {data:{session}}=await supabase.auth.getSession()
    if(!session?.access_token){setLoading(false);setError('Supabase auth session unavailable. Please sign in again.');return}
    const {data,error}=await supabase.from('wallets').select('id,chain,address,status,is_hot,custody_type,wallet_role').eq('owner_id',user.id).eq('wallet_role','trading_hot').order('chain')
    if(error)setError(error.message);else{setWallets(data||[]);setError('')}
    setLoading(false)
  }

  useEffect(()=>{if(!authLoading)load()},[authLoading,user?.id])

  const generate=async()=>{
    setBusy(true);setError('')
    try{
      let {data:{session}}=await supabase.auth.getSession()
      if(!session?.access_token){
        const {data,error:refreshError}=await supabase.auth.refreshSession()
        if(refreshError)throw new Error(`Supabase auth session unavailable: ${refreshError.message}`)
        session=refreshError?null:refreshError
      }
      if(!session?.access_token)throw new Error('Supabase auth session unavailable. Please sign in again.')
      const {data,error}=await supabase.functions.invoke('arbivault-wallet-bootstrap',{
        body:{chains:['bnb','solana','bitcoin']},
        headers:{Authorization:`Bearer ${session.access_token}`}
      })
      if(error)throw error
      if(!data?.ok)throw new Error(data?.error||'Wallet bootstrap failed')
      setWallets(data.wallets||[])
    }catch(e){setError(e.message||'Wallet bootstrap failed')}finally{setBusy(false)}
  }

  return <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
    <div className="flex items-start justify-between gap-3">
      <div><div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]"><KeyRound className="h-3.5 w-3.5"/> Trading Wallets</div>
      <p className="mt-1 text-[0.62rem] text-[#5a6080]">Creates real BNB, SOL and BTC hot-wallet addresses. Signing material stays server-side in Supabase Vault.</p></div>
      <button onClick={load} disabled={authLoading} className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-50" title="Refresh"><RefreshCw className="h-3.5 w-3.5"/></button>
    </div>
    {error&&<div className="mt-3 rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-2 font-mono text-[0.6rem] text-[#FF4D4D]">{error}</div>}
    <div className="mt-3 grid gap-2 md:grid-cols-3">
      {['bnb','solana','bitcoin'].map(chain=>{const w=wallets.find(x=>x.chain===chain);return <div key={chain} className="rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="flex items-center justify-between"><span className="font-mono text-[0.62rem] font-semibold uppercase">{chain}</span>{w&&<ShieldCheck className="h-3.5 w-3.5 text-[#00FF87]"/>}</div>
        <div className="mt-2 break-all font-mono text-[0.55rem] text-[#8a90b0]">{w?.address||'NOT GENERATED'}</div>
      </div>})}
    </div>
    <button onClick={generate} disabled={busy||authLoading||!user} className="mt-3 w-full rounded border border-[#00F0FF]/40 bg-[#00F0FF]/5 px-3 py-2 font-mono text-[0.65rem] font-bold uppercase tracking-wider text-[#00F0FF] disabled:opacity-50">
      {busy?'Generating and securing wallets…':wallets.length>=3?'Wallets ready — verify':'Generate Trading Wallets'}
    </button>
    {loading&&<div className="mt-2 font-mono text-[0.55rem] text-[#5a6080]">{authLoading?'Waiting for Supabase session…':'Checking wallet inventory…'}</div>}
  </div>
}
