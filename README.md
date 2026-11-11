# Jungle Gaming NFT Marketplace

Responsive NFT marketplace demo built with React, TypeScript, TanStack Router, TanStack Query, Axios, Tailwind CSS, shadcn/ui primitives, MSW, Socket.IO, Playwright, and Lighthouse.

## Requirements

- Node.js 22.19 or newer
- npm
- Chromium (install the Playwright browser with `npx playwright install chromium`)

## Setup and run

```sh
npm ci
npm run dev
```

The application uses MSW fixtures by default. To point the browser at a real REST and Socket.IO API, set `VITE_ENABLE_MOCKS=false` and provide a same-origin backend that implements the contracts in [ARCHITECTURE.md](./ARCHITECTURE.md).

Demo logins are `maya@jungle.io` and `alex@jungle.io`; both use `demo123`. These are demo-only credentials, not production authentication. New accounts can also be created in the app. The coupon fixture is `WELCOME10`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development app with the standard mock data |
| `npm run typecheck` | Run the TypeScript project checks |
| `npm run lint` | Run Oxlint |
| `npm run build` | Type-check and create an optimized production build |
| `npm run preview` | Serve the production build locally |
| `npm run test:e2e` | Run Playwright E2E and visual-regression tests |
| `npm run test:e2e:update` | Intentionally update the versioned screenshot baselines |
| `npm run audit:lighthouse` | Build and run the 3-run Lighthouse audit for home/detail on mobile/desktop |

Playwright runs the desktop regression project plus a Pixel 7 Chromium mobile-flow project. It writes its HTML report to `playwright-report/` and failure traces, screenshots, and videos to `test-results/`.
Lighthouse writes the HTML/JSON run reports and median summaries to `lighthouse-reports/`.
If the demo service worker cannot initialize, the app now shows a startup error instead of a blank screen; **Retry startup** unregisters the app-scoped worker and reloads the page.

## Deterministic scenarios

`npm run test:e2e` starts Vite in `test` mode, which loads `.env.test` and enables scenario endpoints. Each Playwright test starts from a fresh browser context and resets the MSW fixture state before running. Scenarios can be driven through:

- `POST /api/__test/reset` — restore the default mock accounts, NFTs, cart, and orders.
- `GET /api/__test/status` — inspect the number of connected mock Socket.IO clients.
- `POST /api/__test/events` — publish a versioned NFT or order update to connected clients.
- `POST /api/__test/session-expiry` — expire the current mock session.
- `POST /api/__test/order-mode` — choose `success`, `payment-failure`, or `timeout`.
- `POST /api/__test/fail-next-favorite` — make the next favorite mutation fail.
- `POST /api/__test/network-mode` — choose `normal`, `variable-latency`, `out-of-order`, `timeout`, `offline`, `http-4xx`, or `http-5xx` for API requests.

Realtime runs in the browser: MSW intercepts the Socket.IO WebSocket with `ws.link`, and `@mswjs/socket.io-binding` adapts intercepted connections to Socket.IO events for `socket.io-client`. The published `0.2.0` package API used here is `toSocketIo(connection)`; the `SocketIo` protocol-class example on the repository's current README is not part of that npm release. This keeps the mock independent of a Vite-only socket server and usable from static hosting. When mocks are disabled, the real backend must provide the REST and Socket.IO contracts.

To enable deterministic scenario endpoints outside Playwright, set `VITE_MOCK_SCENARIOS=true` for the Vite process/build. Select a scenario with `fetch('/api/__test/network-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'http-5xx' }) })`; restore defaults with `POST /api/__test/reset` and return to normal networking with `{ "mode": "normal" }`. Test-only endpoints are intended for the mock demo and must not be enabled against a real backend.

## Known asset and design notes

NFT artwork and the demo avatar currently use Unsplash URLs, so the images require network access. The rest of the interface is styled locally with Tailwind CSS and system fonts. No original Figma asset bundle was present in the supplied project; the existing artwork is a documented visual substitute. The UI uses shadcn/ui primitives for shared controls and cards, alongside project-specific marketplace components.

## Delivery limitation

The workspace has no Git remote or deployment credentials, so a repository link and public deployment URL cannot be supplied from here. A Vercel SPA rewrite is configured in `vercel.json`; the production build and local preview are reproducible with the commands above.
