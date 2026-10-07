import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, Fingerprint, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react'
import AuthLayout from '@/components/AuthLayout'
import { useAuth } from '@/lib/AuthContext'
import { supabase } from '@/lib/supabase'
import { safeReturnTo } from '@/lib/authReturnTo'

export default function AccountLogin() {
  const { user, isLoading: authLoading, login, loginWithPasskey, registerPasskey, unlock, isUnlocked } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const returnTo = safeReturnTo(location.state?.from?.pathname || '/')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [needsPasskey, setNeedsPasskey] = useState(false)

  useEffect(() => {
    if (!authLoading && user) {
      if (isUnlocked) navigate(returnTo, { replace: true })
      else navigate('/unlock', { replace: true, state: { from: location.state?.from } })
    }
  }, [authLoading, user?.id, isUnlocked, navigate, returnTo, location.state?.from])

  const handlePasskeyLogin = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await loginWithPasskey()
      if (!result?.redirected) {
        unlock()
        navigate(returnTo, { replace: true })
      }
    } catch (err) {
      setError(err.message || 'Passkey sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  const handlePasswordLogin = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setNeedsPasskey(false)
    try {
      await login(email.trim(), password)
      setPassword('')

      try {
        const { data: passkeys, error: passkeyError } = await supabase.auth.passkey.list()
        if (!passkeyError && !passkeys?.length) setNeedsPasskey(true)
      } catch (passkeyError) {
        console.warn('Could not inspect passkey inventory', passkeyError)
      }

      unlock()
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError(err.message || 'Unable to sign in')
    } finally {
      setBusy(false)
    }
  }

  const handleRegisterPasskey = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await registerPasskey()
      setNeedsPasskey(false)
      unlock()
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError(err.message || 'Passkey registration failed')
    } finally {
      setBusy(false)
    }
  }

  if (authLoading) {
    return (
      <AuthLayout icon={ShieldCheck} title="Secure sign in" subtitle="Restoring your Supabase session">
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Restoring session…
        </div>
      </AuthLayout>
    )
  }

  if (user) return null

  return (
    <AuthLayout
      icon={ShieldCheck}
      title="Sign in to ArbiVault"
      subtitle="Use your passkey or account password."
      footer={
        <>
          Need an account?{' '}
          <Link to="/register" className="text-primary font-medium hover:underline">Create one</Link>
          {' · '}
          <Link to="/forgot-password" className="text-primary font-medium hover:underline">Forgot password?</Link>
        </>
      }
    >
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="button"
        onClick={handlePasskeyLogin}
        disabled={busy}
        className="h-12 w-full rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Fingerprint className="h-4 w-4" aria-hidden="true" />}
        {busy ? 'Authenticating…' : 'Continue with passkey'}
      </button>

      <p className="mt-3 text-center text-xs text-muted-foreground">
        On Chromebook, Chrome may offer “Use a phone or tablet” to authenticate with a passkey stored on your iPhone.
      </p>

      {needsPasskey && user && (
        <div className="mt-4 rounded-md border border-[#00F0FF]/30 bg-[#00F0FF]/5 p-3">
          <div className="font-medium text-sm">Passkey not enrolled</div>
          <div className="mt-1 text-xs text-muted-foreground">Your account is authenticated. Register a passkey on this device or choose your iPhone when Chrome offers another-device enrollment.</div>
          <button type="button" onClick={handleRegisterPasskey} disabled={busy} className="mt-3 h-10 w-full rounded-md border border-[#00F0FF]/40 font-medium text-sm">Register passkey</button>
        </div>
      )}

      <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <span>or use password</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={handlePasswordLogin} className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="arbivault-email" className="text-sm font-medium">Email</label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input id="arbivault-email" type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} className="h-12 w-full rounded-md border border-border bg-background pl-10 pr-3" required />
          </div>
        </div>
        <div className="space-y-2">
          <label htmlFor="arbivault-password" className="text-sm font-medium">Password</label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input id="arbivault-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-12 w-full rounded-md border border-border bg-background pl-10 pr-3" required />
          </div>
        </div>
        <button type="submit" disabled={busy} className="h-12 w-full rounded-md border border-border bg-background font-medium text-foreground disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in with password'}
        </button>
      </form>
    </AuthLayout>
  )
}
