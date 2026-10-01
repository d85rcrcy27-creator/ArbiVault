// Local vault security: 6-digit PIN (hashed) with platform-biometric (WebAuthn) unlock.
// Everything here is client-side only — this app has no server component.

const CONFIG_KEY = 'arbivault.security';
const LOCKOUT_KEY = 'arbivault.lockout';
const UNLOCK_KEY = 'arbivault.unlocked';
const PIN_SALT = 'arbivault_pin_';
const RP_NAME = 'ArbiVault';

export const PIN_LENGTH = 6;
export const MAX_ATTEMPTS = 3;
export const LOCKOUT_MS = 30 * 60 * 1000;

export async function hashPin(pin) {
  const data = new TextEncoder().encode(PIN_SALT + pin);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
