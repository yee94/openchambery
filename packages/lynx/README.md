# `@openchamber/lynx`

Lynx-track modules for the independent `work/lynx-native` rewrite. **Do not merge to `main`.**

There is no Lynx host app in this repository yet. This package is the import path the future iOS/Android shell should call.

## Connect kernel

```ts
import { createLynxConnectionController } from '@openchamber/lynx/connect';
```

See `src/connect/DOCUMENTATION.md` for the official API map, persistence keys, and host adapter contracts.

What this package does:

- Splash/auto-connect against real `GET /health` + `GET /auth/session`
- Instance list add / delete / password unlock
- Persist the full LAN + relay candidate set (`relayUrl` + `hostEncPubJwk`)
- Pairing v2 QR / paste / `openchamber://connect?v=2&p=…` redeem on `POST /api/client-auth/pairing/redeem`
- Same deep-link intent union as Capacitor `deepLinks.ts`
- Secure-store adapter for tokens (never logged)

What this package does **not** do:

- Bonjour / Nearby / LAN browse
- Invented redeem or ASR/voice
- Draw a Lynx splash page (kernel exposes `phase` + `autoConnectLabel`; the host view is still missing)
- Bind Keychain/Keystore or a camera (host adapters; labeled stubs)

## Test

```sh
bunx vitest run --project @openchamber/lynx
```
