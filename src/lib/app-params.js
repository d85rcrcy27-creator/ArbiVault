const isNode = typeof window === 'undefined';

const isClearAccessTokenRequested = () =>
  !isNode && new URLSearchParams(window.location.search).get("clear_access_token") === 'true';

const clearStoredAccessToken = () => {
  window.localStorage.removeItem('token');
};

const getAppParams = () => {
  if (isClearAccessTokenRequested()) {
    clearStoredAccessToken();
  }
  return {
    appId: import.meta.env.VITE_SUPABASE_URL,
    token: isNode ? null : window.localStorage.getItem('token'),
    functionsVersion: import.meta.env.VITE_APP_VERSION,
    appBaseUrl: isNode ? '' : window.location.origin,
  };
};

export const appParams = getAppParams();
