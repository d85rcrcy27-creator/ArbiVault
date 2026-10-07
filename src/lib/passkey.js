const DEFAULT_PASSKEY_ORIGIN = 'https://arbivault.vercel.app'

function configuredPasskeyOrigin() {
  const raw = import.meta.env.VITE_PASSKEY_ORIGIN || DEFAULT_PASSKEY_ORIGIN
  try {
    return new URL(raw).origin
  } catch {
    return DEFAULT_PASSKEY_ORIGIN
  }
}

export const PASSKEY_ORIGIN = configuredPasskeyOrigin()

/**
 * Supabase/WebAuthn is configured with RP ID "arbivault.vercel.app".
 * Vercel deployment URLs such as *.vercel.app are sibling hosts, not
 * subdomains of arbivault.vercel.app, so browsers correctly reject the
 * ceremony there. Always move passkey ceremonies to the canonical origin.
 */
export function ensureCanonicalPasskeyOrigin() {
  if (typeof window === 'undefined') return true
  if (window.location.origin === PASSKEY_ORIGIN) return true

  const target = new URL(PASSKEY_ORIGIN)
  target.pathname = window.location.pathname
  target.search = window.location.search
  target.hash = window.location.hash
  window.location.replace(target.toString())
  return false
}
