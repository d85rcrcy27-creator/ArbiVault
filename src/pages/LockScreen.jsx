import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, Loader2, ShieldCheck, Mail, Lock, Fingerprint } from 'lucide-react'
import AuthLayout from '@/components/AuthLayout'
import PinPad from '@/components/lock/PinPad'
import { useAuth } from '@/lib/AuthContext'
import { safeReturnTo } from '@/lib/authReturnTo'
import {
  getSecurityConfig,
  saveSecurityConfig,
  hashPin,
  verifyPin,
  getLockoutState,
  saveLockoutState,
  resetLockoutState,
  setUnlocked,
  PIN_LENGTH,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
} from '@/lib/security'

const STAGE_COPY = {
  create: { title: 'Create your PIN', subtitle: `Choose a ${PIN_LENGTH}-digit PIN to lock this device` },
  confirm: { title: 'Confirm your PIN', subtitle: 'Enter the same PIN once more' },
  enter: { title: 'Enter your PIN', subtitle: 'Unlock ArbiVault' },
}

const formatRemaining = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export default function LockScreen() {
  const { user, isLoading: authLoading, login, loginWithPasskey, unlock } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [stage, setStage] = useState(() => (getSecurityConfig()?.pinHash ? 'enter' : 'create'))
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accountUnlockMode, setAccountUnlockMode] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [lockout, setLockout] = useState(() => getLockoutState())

  const returnTo = safeReturnTo(location.state?.from?.pathname || '/')
  const lockedFor = lockout.lockedUntil - Date.now()
  const isLockedOut = lockedFor > 0

  useEffect(() => {
    if (!isLockedOut) return
    const id = setInterval(() => setLockout(getLockoutState()), 1000)
    return () => clearInterval(id)
  }, [isLockedOut])

  const enter = () => {
    resetLockoutState()
    // This unlocks only the local vault gate. Supabase authentication is
    // already established separately by the account login below.
    setUnlocked(true)
    navigate(returnTo, { replace: true })
  }

  const handleAccountLogin = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await login(email.trim(), password)
      setPassword('')
      unlock()
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError(err.message || 'Unable to sign in')
    } finally {
      setBusy(false)
    }
  }

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

  const handleKey = async (key) => {
    if (busy || isLockedOut) return
    setError('')
    if (key === 'del') {
      setPin((prev) => prev.slice(0, -1))
      return
    }

    const next = pin.length >= PIN_LENGTH ? pin : pin + key
    setPin(next)
    if (next.length < PIN_LENGTH) return

    if (stage === 'create') {
      setConfirmPin(next)
      setPin('')
      setStage('confirm')
      return
    }

    if (stage === 'confirm') {
      if (next !== confirmPin) {
        setPin('')
        setConfirmPin('')
        setStage('create')
        setError('PINs did not match — start again.')
        return
      }
      setBusy(true)
      saveSecurityConfig({ pinHash: await hashPin(next), createdAt: new Date().toISOString() })
      setBusy(false)
      setPin('')
      enter()
      return
    }

    setBusy(true)
    const ok = await verifyPin(next, getSecurityConfig()?.pinHash)
    setBusy(false)
    setPin('')
    if (ok) {
      enter()
      return
    }

    const attempts = (lockout.attempts || 0) + 1
    const nextLockout = attempts >= MAX_ATTEMPTS
      ? { attempts: 0, lockedUntil: Date.now() + LOCKOUT_MS }
      : { attempts, lockedUntil: 0 }
    saveLockoutState(nextLockout)
    setLockout(nextLockout)
    setError(
      attempts >= MAX_ATTEMPTS
        ? `Too many attempts. Try again in ${Math.round(LOCKOUT_MS / 60000)} minutes.`
        : `Incorrect PIN. ${MAX_ATTEMPTS - attempts} attempt${MAX_ATTEMPTS - attempts === 1 ? '' : 's'} left.`
    )
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

  // The old /login screen only unlocked the local PIN. That left the app
  // without a Supabase user, which made wallet bootstrap correctly reject the
  // request. Establish the real Supabase session first, then unlock the vault.
  if (!user) {
    return (
      <AuthLayout
        icon={ShieldCheck}
        title="Sign in to ArbiVault"
        subtitle="Use your passkey or your account password."
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

        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          <span>or use password</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleAccountLogin} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="arbivault-email" className="text-sm font-medium">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <input
                id="arbivault-email"
                type="email"
                autoComplete="username webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 w-full rounded-md border border-border bg-background pl-10 pr-3"
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="arbivault-password" className="text-sm font-medium">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <input
                id="arbivault-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 w-full rounded-md border border-border bg-background pl-10 pr-3"
                required
              />
            </div>
          </div>
          <button type="submit" disabled={busy} className="h-12 w-full rounded-md border border-border bg-background font-medium text-foreground disabled:opacity-50">
            {busy ? 'Signing in…' : 'Sign in with password'}
          </button>
        </form>
      </AuthLayout>
    )
  }

  const copy = STAGE_COPY[stage]

  const handleAccountUnlock = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const accountEmail = (user?.email || email).trim()
      if (!accountEmail || !password) throw new Error('Enter your account password to unlock this device.')
      await login(accountEmail, password)
      setPassword('')
      unlock()
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError(err.message || 'Unable to verify account password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout icon={ShieldCheck} title={copy.title} subtitle={copy.subtitle}>
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {isLockedOut ? (
        <div className="py-8 text-center">
          <p className="font-mono text-3xl font-semibold text-foreground">{formatRemaining(lockedFor)}</p>
          <p className="mt-2 text-sm text-muted-foreground">Locked — too many incorrect attempts.</p>
        </div>
      ) : (
        <PinPad value={pin} onKey={handleKey} disabled={busy} />
      )}

      {busy && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Verifying…
        </div>
      )}

      <div className="mt-6 border-t border-border pt-5">
        {!accountUnlockMode && (
          <button
            type="button"
            onClick={handlePasskeyLogin}
            disabled={busy}
            className="mb-3 h-11 w-full rounded-md border border-border bg-background font-medium text-foreground disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Fingerprint className="h-4 w-4" aria-hidden="true" />}
            {busy ? 'Authenticating…' : 'Unlock with passkey'}
          </button>
        )}


        {!accountUnlockMode ? (
          <button
            type="button"
            onClick={() => { setAccountUnlockMode(true); setError(''); setPin('') }}
            className="w-full text-sm text-primary hover:underline"
          >
            Forgot your PIN? Unlock with account password
          </button>
        ) : (
          <form onSubmit={handleAccountUnlock} className="space-y-3">
            <p className="text-sm text-muted-foreground">Verify your ArbiVault account password to unlock this device without the local PIN.</p>
            <input
              type="email"
              value={user?.email || email}
              readOnly={!!user?.email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              className="h-11 w-full rounded-md border border-border bg-background px-3"
              required
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Account password"
              className="h-11 w-full rounded-md border border-border bg-background px-3"
              required
            />
            <button type="submit" disabled={busy} className="h-11 w-full rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
              {busy ? 'Verifying…' : 'Unlock with account password'}
            </button>
            <button
              type="button"
              onClick={() => { setAccountUnlockMode(false); setPassword(''); setError('') }}
              className="w-full text-sm text-muted-foreground hover:underline"
            >
              Back to PIN
            </button>
          </form>
        )}
      </div>
    </AuthLayout>
  )
}
