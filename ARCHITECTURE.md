# Architecture and API contracts

## Application structure

- `src/App.tsx` composes the TanStack Router route tree and page UI; account, cart, favorites, wallets, and orders are fetched through TanStack Query.
- `src/lib/api.ts` is the Axios client used by UI operations.
- `src/lib/msw.ts` provides REST fixtures, persisted mock state, and test-only event scenarios.
- `src/lib/realtime.ts` creates the Socket.IO client and declares the event envelope types.
- `src/lib/mockData.ts` contains the deterministic demo account, catalog, wallets, and orders.
- `e2e/marketplace.spec.ts` contains browser-level functional, responsive, realtime, and visual-regression checks.
- `scripts/lighthouse-audit.mjs` measures the optimized preview build and writes three-run reports.

## REST contracts

| Method and path | Request | Response / behavior |
| --- | --- | --- |
| `GET /api/session` | — | `{ user }`; `user` is `null` after mock logout |
| `POST /api/login` | `{ email, password }` | `{ user, cart }`; validates the stored demo password digest and merges the guest cart |
| `POST /api/signup` | `{ name, email, password }` | `{ user, cart }`; validates input and returns `409` for duplicate email |
| `POST /api/logout` | — | `{ success: true }`; clears the mock session |
| `GET /api/profile` | — | `{ user }`; requires an active session |
| `PATCH /api/profile` | `{ name, email, avatar }` | `{ user }`; validates values and returns `409` if the email belongs to another account |
| `PUT /api/profile/password` | `{ currentPassword, newPassword }` | `{ success: true }`; validates the current password |
| `GET /api/nfts` | `search`, `category`, `sort`, `page`, `limit` query parameters | `{ items, total, page, limit, versions }` |
| `GET /api/nfts/:id` | — | `{ nft }`, or `404` for an unknown NFT |
| `GET /api/favorites` | — | `{ favorites: string[] }` |
| `POST /api/favorites/:nftId` | — | Adds an NFT to favorites |
| `DELETE /api/favorites/:nftId` | — | Removes an NFT from favorites |
| `GET /api/cart` | — | `{ cart: CartItem[] }` |
| `POST /api/cart` | `{ nftId, quantity }` | `{ cart }`; adds an item or increments its quantity |
| `PUT /api/cart/:nftId` | `{ quantity }` | `{ cart }`; removes the item when quantity is zero |
| `DELETE /api/cart/:nftId` | — | `{ cart }` after removal |
| `GET /api/wallets` | — | `{ wallets }` |
| `POST /api/wallets` | `{ label, address, network }` | `{ wallet, wallets }` |
| `PUT /api/wallets/:walletId` | `{ label, address, network }` | Updates an owned wallet |
| `PATCH /api/wallets/:walletId/primary` | — | Sets the wallet as primary |
| `DELETE /api/wallets/:walletId` | — | Removes an owned wallet |
| `POST /api/coupons/validate` | `{ code }` | `{ valid, discount, label }`, or `400` for invalid codes |
| `POST /api/quote` | `{ items, couponCode? }` | Server-calculated items, availability, subtotal, discount, network fee, and total |
| `POST /api/orders` | `{ items, total, couponCode?, idempotencyKey }` | Recalculates the quote; returns `409` if availability or price changed; status is `pending`, `confirmed`, or `refused` |
| `GET /api/orders` | — | `{ orders }` for the active account |
| `GET /api/orders/:orderId` | — | `{ order }`, or `404` for an unknown order |

Test-only endpoints are enabled only when `VITE_MOCK_SCENARIOS=true`: `POST /api/__test/reset`, `GET /api/__test/status`, `POST /api/__test/events`, `POST /api/__test/session-expiry`, `POST /api/__test/order-mode`, `POST /api/__test/fail-next-favorite`, and `POST /api/__test/network-mode`. Network modes select variable latency, deliberately out-of-order catalog responses, request timeouts, offline errors, and HTTP 4xx/5xx responses. Event scenarios update the MSW fixture and publish through the intercepted Socket.IO connection, rather than calling UI setters or the query cache directly.

## Realtime events and reconciliation

The client listens for:

```ts
type RealtimeEvent<T> = {
  eventId: string
  resourceId: string
  version: number
  userId?: string
  data: T
}
```

- `nft.updated` is broadcast to connected clients and refreshes the relevant TanStack Query cache entries. Checkout recalculates the total and requires the buyer to review the changed quote again.
- `order.updated` includes `userId` and is sent only to connections whose user identity was derived from the mock session. The client also verifies that the event user matches the active account; a client-supplied user ID is never trusted.
- The client drops missing, duplicate, and out-of-order events using `eventId`, `resourceId`, and monotonically increasing `version` values.
- On connection/reconnection, the client fetches the catalog and reconciles pending orders with REST. REST remains the source of truth for full resource state.

The browser uses the WebSocket transport and `ws.link` to intercept Socket.IO at `/socket.io/`. `@mswjs/socket.io-binding@0.2.0` exposes the intercepted connection through `toSocketIo`; the current GitHub README's `SocketIo` protocol-class API is not published in the installed npm release. There is no Vite-hosted socket server, so the mock works in static hosting as long as the service worker is available. A real backend must authenticate the handshake and authorize event delivery server-side.

## Session, cart, and cache policy

- The MSW fixture state, including account-scoped cart/favorites/wallet/order data, is persisted under `jungle-marketplace-state`; TanStack Query is the UI's source of truth. Query keys for account resources include the active user ID.
- The mock session expires after eight hours and is checked by protected-route guards and API handlers. Logout removes private query entries, updates the session, and tears down the old user's realtime connection. Login/signup merges the visitor cart into that account.
- TanStack Query uses a 15-second `staleTime` and one retry. Socket events update cached NFT data; reconnect reconciliation refreshes from REST.
- Cart quantity changes are optimistic in the UI and synchronized through the mock REST handlers. Checkout blocks unavailable quantities and requires renewed confirmation after price/availability changes.
- Each checkout attempt gets a random idempotency key that is retained for safe retries and reused only while its quote fingerprint is unchanged. A subsequent purchase gets a new key, even if its cart contents match.

## UX, accessibility, and asset decisions

- The app displays an accessible startup status while MSW initializes. If startup stalls or fails, it shows a recovery action that bounds service-worker cleanup and reloads instead of leaving a blank page.
- The header collapses to a labeled mobile navigation menu; responsive checks cover 390, 768, and 1440 pixels.
- Realtime updates and checkout validation use live/status or alert semantics. Interactive controls have labels, and focus-visible styles are used for keyboard navigation.
- The supplied workspace did not include a Figma export or artwork bundle. Existing Unsplash artwork and avatar URLs are visual substitutes and require network access; system fonts avoid an external font dependency.
- Shared controls and cards use shadcn/ui primitives styled to the marketplace theme. A production design handoff should replace the temporary artwork with licensed, local Figma exports and compare the layouts against the source design.

## Audit and test reproducibility

- Playwright uses Chromium desktop plus a Pixel 7 mobile project, a single worker, fresh browser contexts, mock reset, traces on failure, and versioned screenshot baselines for home, NFT detail, cart, and checkout at 390px and 1440px.
- `npm run audit:lighthouse` first creates the optimized build, serves it through Vite preview with the standard mock fixture, then runs three Lighthouse measurements for home and NFT detail at mobile and desktop profiles. Individual HTML/JSON reports and the median summary are written to `lighthouse-reports/`.
- Lighthouse uses simulated mobile throttling and an unthrottled desktop profile. Reported LCP, CLS, and TBT describe the supplied assets and machine/browser environment; external Unsplash latency can affect results.
- Final audit (three-run medians; Lighthouse 13.6.0, Chromium, Node 24.14.1, Windows x64):

  | Page / profile | Performance | Accessibility | Best practices | SEO | LCP | CLS | TBT |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
  | Home / mobile | 62 | 100 | 100 | 100 | 3481 ms | 0.000 | 2847 ms |
  | Home / desktop | 84 | 100 | 100 | 100 | 1863 ms | 0.067 | 189 ms |
  | NFT detail / mobile | 64 | 100 | 100 | 100 | 3298 ms | 0.000 | 2106 ms |
  | NFT detail / desktop | 82 | 100 | 100 | 100 | 1399 ms | 0.000 | 308 ms |

- Performance is below the 90-point target in all four profiles and varies substantially between runs. Lighthouse identifies the externally hosted Unsplash hero artwork as the LCP element; the image URL is discovered only after the app and mock API load, and the request has no high-priority hint. On mobile, simulated CPU throttling compounds the roughly 299 KiB compressed app and MSW JavaScript payloads, with script evaluation contributing to high TBT. Detailed evidence and all individual runs are in `lighthouse-reports/summary.json` and the adjacent per-run HTML/JSON reports.
