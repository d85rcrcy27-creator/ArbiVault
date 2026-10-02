import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Fingerprint, Shield, AlertTriangle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import PinPad from '@/components/lock/PinPad';
import { useAuth } from '@/lib/AuthContext';
import {
  hashPin,
  verifyPin,
  getSecurityConfig,
  saveSecurityConfig,
  isBiometricAvailable,
  registerBiometric,
  authenticateBiometric,
  getLockoutState,
  saveLockoutState,
  resetLockoutState,
  PIN_LENGTH,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
} from '@/lib/security';

export default function LockScreen() {
  const navigate = useNavigate();
  const { unlock } = useAuth();

  const [config, setConfig] = useState(() => getSecurityConfig());
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [stage, setStage] = useState(() => (getSecurityConfig() ? 'biometric' : 'create'));
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [lockout, setLockout] = useState(() => getLockoutState());

  useEffect(() => {
    isBiometricAvailable().then(setBiometricAvailable);
  }, []);

  const isLockedOut = lockout.lockedUntil > Date.now();
  const hasBiometric = biometricAvailable && !!config?.credentialId;

  const enter = () => {
    resetLockoutState();
    unlock();
    navigate('/', { replace: true });
  };

  async function createPin(e) {
    e.preventDefault();
    setError('');
    if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
      setError(`PIN must be ${PIN_LENGTH} digits.`);
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs do not match.');
      return;
    }
    setBusy(true);
    const pinHash = await hashPin(pin);
    const next = { pinHash, credentialId: config?.credentialId || null };
    saveSecurityConfig(next);
    setConfig(next);
    setBusy(false);
    setPin('');
    setConfirmPin('');
    if (biometricAvailable) setStage('enroll');
    else enter();
  }

  async function enrollBiometric() {
    setError('');
    setBusy(true);
    const ok = await registerBiometric();
    setBusy(false);
    if (!ok) {
      setError('Biometric setup failed. You can still unlock with your PIN.');
      return;
    }
    setConfig(getSecurityConfig());
    enter();
  }

  async function scanBiometric() {
    if (scanning) return;
    setError('');
    setScanning(true);
    const ok = await authenticateBiometric();
    setScanning(false);
    if (ok) enter();
    else {
      setError('Biometric check failed. Enter your PIN.');
      setStage('pin');
    }
  }

  async function submitPin(candidate) {
    const current = getSecurityConfig();
    if (!current) {
      setStage('create');
      return;
    }
    if (await verifyPin(candidate, current.pinHash)) {
      setPin('');
      enter();
      return;
    }
    const attempts = lockout.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const next = { attempts: 0, lockedUntil: Date.now() + LOCKOUT_MS };
      saveLockoutState(next);
      setLockout(next);
      setError('Too many failed attempts. Locked for 30 minutes.');
    } else {
      const next = { ...lockout, attempts };
      saveLockoutState(next);
      setLockout(next);
      const left = MAX_ATTEMPTS - attempts;
      setError(`Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} remaining.`);
    }
    setPin('');
  }

  function handleKey(key) {
    if (key === 'del') {
      setPin((p) => p.slice(0, -1));
      return;
    }
    setPin((p) => {
      if (p.length >= PIN_LENGTH) return p;
      const next = p + key;
      if (next.length === PIN_LENGTH) setTimeout(() => submitPin(next), 150);
      return next;
    });
  }

  if (isLockedOut) {
    const minutes = Math.max(1, Math.ceil((lockout.lockedUntil - Date.now()) / 60000));
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm text-center">
          <AlertTriangle className="mx-auto h-14 w-14 text-destructive" />
          <h1 className="mt-4 text-2xl font-bold text-foreground">Vault locked</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Too many failed attempts. Try again in {minutes} minute{minutes === 1 ? '' : 's'}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary mb-4">
            <Shield className="w-7 h-7 text-primary-foreground" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">ArbiVault</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {stage === 'create'
              ? 'Create a PIN to secure this vault'
              : stage === 'enroll'
                ? 'Enable biometric unlock'
                : 'Secure access required'}
          </p>
        </div>

        <div className="bg-card rounded-2xl border border-border p-6">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          {stage === 'create' && (
            <form onSubmit={createPin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="pin">New {PIN_LENGTH}-digit PIN</Label>
                <Input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={PIN_LENGTH}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••••"
                  className="h-12 text-center text-lg tracking-[0.4em] font-mono"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-pin">Confirm PIN</Label>
                <Input
                  id="confirm-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={PIN_LENGTH}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••••"
                  className="h-12 text-center text-lg tracking-[0.4em] font-mono"
                  required
                />
              </div>
              <Button type="submit" className="w-full h-12 font-medium" disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Continue
              </Button>
            </form>
          )}

          {stage === 'enroll' && (
            <div className="text-center space-y-4">
              <Fingerprint className="mx-auto h-12 w-12 text-primary" />
              <p className="text-sm text-muted-foreground">
                Register your fingerprint or Face ID for faster access. Your PIN always works as a
                fallback.
              </p>
              <Button className="w-full h-12 font-medium" onClick={enrollBiometric} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Enable biometric unlock
              </Button>
              <Button variant="ghost" className="w-full" onClick={enter} disabled={busy}>
                Skip for now
              </Button>
            </div>
          )}

          {stage === 'biometric' && hasBiometric && (
            <div className="text-center space-y-4">
              <button
                type="button"
                onClick={scanBiometric}
                disabled={scanning}
                className="group mx-auto flex h-24 w-24 items-center justify-center rounded-full border-2 border-primary/30 bg-primary/5 transition-all hover:border-primary/60 hover:bg-primary/10 disabled:opacity-50"
              >
                <Fingerprint
                  className={`h-12 w-12 text-primary transition-transform group-hover:scale-110 ${scanning ? 'animate-pulse' : ''}`}
                />
              </button>
              <p className="text-sm text-muted-foreground">
                {scanning ? 'Verifying…' : 'Tap to unlock with biometrics'}
              </p>
              <Button variant="ghost" className="w-full" onClick={() => setStage('pin')}>
                Use PIN instead
              </Button>
            </div>
          )}

          {stage !== 'create' && stage !== 'enroll' && !(stage === 'biometric' && hasBiometric) && (
            <div className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                Enter your {PIN_LENGTH}-digit PIN
              </p>
              <PinPad value={pin} onKey={handleKey} />
              {hasBiometric && (
                <Button variant="ghost" className="w-full" onClick={() => setStage('biometric')}>
                  Use biometrics instead
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
