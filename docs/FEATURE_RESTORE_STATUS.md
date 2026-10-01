# Feature restoration status

Implemented on this branch:

- persistent bot skills
- persistent simulated trade history
- honest transaction-hash handling
- wallet and approved-destination dashboard
- approved-destination activation gate
- bot-to-wallet binding schema
- Vault bridge migration for server-side custody integration

Not enabled in the browser:

- private-key generation
- private-key display/export
- automatic signing from the Vite client

Those custody operations must remain server-side and isolated from the browser.
