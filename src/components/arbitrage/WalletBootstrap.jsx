import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, RefreshCw } from 'lucide-react'
import { getAuthenticatedSession, supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/AuthContext'

export default function WalletBootstrap() {
  const [wallets,setWallets]=useState([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const { user, isLoading: authLoading } = useAuth()

  // AuthContext can render the user a moment before supabase-js finishes
  // restoring the session in its client. Wait briefly for that session instead
  // of surfacing a false "Auth session missing" error.
  const waitForSession = async () => {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) return data.session

    return new Promise((resolve, reject) => {
      let settled = false
      let subscription
      let timer

      const finish = (fn, value) => {
        if (settled) return
        settled = true
        subscription?.unsubscribe()
        clearTimeout(timer)
        fn(value)
      }

      const authState = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.access_token) finish(resolve, session)
      })
      subscription = authState.data.subscription

      timer = setTimeout(async () => {
        try {
          const session = await getAuthenticatedSession()
          finish(resolve, session)
        } catch (error) {
          finish(reject, error)
        }
      }, 1500)
    })
  }

  const load=async()=>{
    setLoading(true)
    let session
    try {
      session = await waitForSession()
    } catch(e) {
      setLoading(false)
      setError(e.message || 'Supabase auth session unavailable. Please sign in again.')
      return
    }
    const {data,error}=await supabase.from('wallets').select('id,chain,address,status,is_hot,custody_type,wallet_role').eq('owner_id',session.user.id).eq('wallet_role','trading_hot').order('chain')
    if(error)setError(error.message);else{setWallets(data||[]);setError('')}
    setLoading(false)
  }

  useEffect(()=>{
    if(authLoading||!user)return
    let active=true
    const ensure=async()=>{
      await load()
      try{
        const session=await waitForSession()
        const {data:existing}=await supabase.from('wallets').select('chain').eq('owner_id',session.user.id).eq('wallet_role','trading_hot').eq('status','active')
        const required=['bnb','solana','ethereum','bitcoin']
        const missing=required.some((chain)=>!(existing||[]).some((w)=>w.chain===chain))
        if(missing){
          const {data,error}=await supabase.functions.invoke('arbivault-wallet-bootstrap',{
            body:{chains:required}
          })
          if(error)throw error
          if(active&&data?.wallets)setWallets(data.wallets)
        }
      }catch(e){
        if(active)setError(e.message||'Wallet bootstrap failed')
      }
    }
    ensure()
    return()=>{active=false}
  },[authLoading,user?.id])

  const generate=async()=>{
    setBusy(true);setError('')
    try{
      const session = await waitForSession()
      const {data,error}=await supabase.functions.invoke('arbivault-wallet-bootstrap',{
        body:{chains:['bnb','solana','ethereum','bitcoin']}
      })
      if(error)throw error
      if(!data?.ok)throw new Error(data?.error||'Wallet bootstrap failed')
      setWallets(data.wallets||[])
    }catch(e){setError(e.message||'Wallet bootstrap failed')}finally{setBusy(false)}
  }

  return <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
    <div className="flex items-start justify-between gap-3">
      <div><div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]"><KeyRound className="h-3.5 w-3.5"/> Trading Wallets</div>
      <p className="mt-1 text-[0.62rem] text-[#5a6080]">Ensures real BNB, SOL, ETH and BTC trading wallets. Signing material stays server-side in Supabase Vault.</p></div>
      <button onClick={load} disabled={authLoading} className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-50" title="Refresh"><RefreshCw className="h-3.5 w-3.5"/></button>
    </div>
    {error&&<div className="mt-3 rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-2 font-mono text-[0.6rem] text-[#FF4D4D]">{error}</div>}
    <div className="mt-3 grid gap-2 md:grid-cols-4">
      {['bnb','solana','ethereum','bitcoin'].map(chain=>{const w=wallets.find(x=>x.chain===chain);return <div key={chain} className="rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="flex items-center justify-between"><span className="font-mono text-[0.62rem] font-semibold uppercase">{chain}</span>{w&&<ShieldCheck className="h-3.5 w-3.5 text-[#00FF87]"/>}</div>
        <div className="mt-2 break-all font-mono text-[0.55rem] text-[#8a90b0]">{w?.address||'NOT GENERATED'}</div>
      </div>})}
    </div>
    <button onClick={generate} disabled={busy||authLoading||!user} className="mt-3 w-full rounded border border-[#00F0FF]/40 bg-[#00F0FF]/5 px-3 py-2 font-mono text-[0.65rem] font-bold uppercase tracking-wider text-[#00F0FF] disabled:opacity-50">
      {busy?'Generating and securing wallets…':wallets.length>=4?'Wallets ready — verify':'Generate Trading Wallets'}
    </button>
    {loading&&<div className="mt-2 font-mono text-[0.55rem] text-[#5a6080]">{authLoading?'Waiting for Supabase session…':'Checking wallet inventory…'}</div>}
  </div>
}
