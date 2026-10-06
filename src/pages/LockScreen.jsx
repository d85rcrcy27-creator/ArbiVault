import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
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
  const { unlock } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [stage, setStage] = useState(() => (getSecurityConfig()?.pinHash ? 'enter' : 'create'))
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
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
    unlock()
    navigate(returnTo, { replace: true })
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

  const copy = STAGE_COPY[stage]

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
    </AuthLayout>
  )
}
