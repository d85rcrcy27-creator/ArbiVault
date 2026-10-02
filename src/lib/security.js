// Local vault security: 6-digit PIN (hashed) with platform-biometric (WebAuthn) unlock.
// Everything here is client-side only — this app has no server component.

const CONFIG_KEY = 'arbivault.security';
const LOCKOUT_KEY = 'arbivault.lockout';
const UNLOCK_KEY = 'arbivault.unlocked';
const RP_NAME = 'ArbiVault';

export const PIN_LENGTH = 6;
export const MAX_ATTEMPTS = 3;
export const LOCKOUT_MS = 30 * 60 * 1000;

// PBKDF2 (OWASP-recommended) replaces the legacy single-iteration SHA-256:
// a 6-digit PIN under one unsalted SHA-256 round is brute-forceable in
// milliseconds, PBKDF2 with 310k iterations and a random per-PIN salt makes
// each guess computationally expensive.
const PBKDF2_ITERATIONS = 310_000;
const LEGACY_PIN_SALT = 'arbivault_pin_';

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

// Constant-time string compare — prevents leaking the hash via response timing.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

// Hash a PIN for storage: "pbkdf2$<iterations>$<saltB64>$<hashB64>".
export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

// Legacy single-round SHA-256 — verification only, kept so existing vaults
// keep unlocking and get transparently upgraded to PBKDF2 on first success.
async function legacyHashPin(pin) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(LEGACY_PIN_SALT + pin)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Verify a candidate PIN against the stored hash. Accepts both the current
// PBKDF2 format and the legacy SHA-256 format; a legacy match is re-stored
// as PBKDF2 so the weak hash disappears after one successful unlock.
export async function verifyPin(pin, stored) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, iterations, salt, hash] = stored.split('$');
    const candidate = await pbkdf2(pin, fromB64(salt), Number(iterations));
    return timingSafeEqual(toB64(candidate), hash);
  }
  const legacy = await legacyHashPin(pin);
  if (!timingSafeEqual(legacy, stored)) return false;
  const config = getSecurityConfig();
  if (config?.pinHash === stored) {
    saveSecurityConfig({ ...config, pinHash: await hashPin(pin) });
  }
  return true;
}

export function getSecurityConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSecurityConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export async function isBiometricAvailable() {
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

// Enroll this device's platform authenticator (fingerprint / Face ID).
export async function registerBiometric() {
  if (!(await isBiometricAvailable())) return false;
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: RP_NAME },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'vault-user',
          displayName: RP_NAME,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
        },
        timeout: 60000,
        attestation: 'none',
      },
    });
    if (!credential) return false;
    saveSecurityConfig({
      ...(getSecurityConfig() || {}),
      credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    });
    return true;
  } catch {
    return false;
  }
}

export async function authenticateBiometric() {
  const config = getSecurityConfig();
  if (!config?.credentialId) return false;
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: fromBase64Url(config.credentialId), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!assertion;
  } catch {
    return false;
  }
}

export function getLockoutState() {
  try {
    const raw = localStorage.getItem(LOCKOUT_KEY);
    return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: 0 };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

export function saveLockoutState(state) {
  localStorage.setItem(LOCKOUT_KEY, JSON.stringify(state));
}

export function resetLockoutState() {
  localStorage.removeItem(LOCKOUT_KEY);
}

// An unlock lasts for the browser tab session.
export function isUnlocked() {
  return sessionStorage.getItem(UNLOCK_KEY) === '1';
}

export function setUnlocked(value) {
  if (value) sessionStorage.setItem(UNLOCK_KEY, '1');
  else sessionStorage.removeItem(UNLOCK_KEY);
}
