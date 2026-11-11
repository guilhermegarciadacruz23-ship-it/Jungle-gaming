import { delay, http, HttpResponse, ws } from 'msw'
import { setupWorker } from 'msw/browser'
import { toSocketIo } from '@mswjs/socket.io-binding'
import { demoOrders, demoUser, demoUserSecond, demoWallets, nftCatalog } from './mockData'
import { compareEth } from './eth'
import { calculateQuote } from './quote'
import type { CartItem, NFT, Order, User, Wallet } from '../types'

type MockState = {
  user: User | null
  favorites: string[]
  cart: CartItem[]
  guestCart: CartItem[]
  wallets: Wallet[]
  orders: Order[]
  nfts: NFT[]
  versions: Record<string, number>
  idempotency: Record<string, { fingerprint: string; order: Order }>
  userData: Record<string, { favorites: string[]; cart: CartItem[]; wallets: Wallet[]; orders: Order[] }>
  accounts: Record<string, User>
  passwordDigests: Record<string, string>
  sessionExpiresAt: number | null
  orderMode: 'success' | 'payment-failure' | 'timeout'
  networkMode: 'normal' | 'variable-latency' | 'out-of-order' | 'timeout' | 'offline' | 'http-4xx' | 'http-5xx'
  failNextFavoriteMutation: boolean
}

const createEmptyUserData = () => ({ favorites: [], cart: [], wallets: [], orders: [] })
const demoPasswordDigest = 'd3ad9315b7be5dd53b31a273b3b3aba5defe700808305aa16a3062b76658a791'
let networkRequestCount = 0

const initialState = (): MockState => ({
  user: demoUser,
  favorites: ['nft-003'],
  cart: [{ nftId: 'nft-002', quantity: 2 }],
  guestCart: [],
  wallets: [...demoWallets],
  orders: [...demoOrders],
  nfts: nftCatalog.map((nft) => ({ ...nft })),
  versions: {},
  idempotency: {},
  userData: {
    [demoUser.id]: {
      favorites: ['nft-003'],
      cart: [{ nftId: 'nft-002', quantity: 2 }],
      wallets: [...demoWallets],
      orders: [...demoOrders],
    },
    [demoUserSecond.id]: createEmptyUserData(),
  },
  accounts: { [demoUser.email]: demoUser, [demoUserSecond.email]: demoUserSecond },
  passwordDigests: { [demoUser.email]: demoPasswordDigest, [demoUserSecond.email]: demoPasswordDigest },
  sessionExpiresAt: null,
  orderMode: 'success',
  networkMode: 'normal',
  failNextFavoriteMutation: false,
})

const readState = (): MockState => {
  const raw = localStorage.getItem('jungle-marketplace-state')
  try {
    if (!raw) return initialState()
    const stored = JSON.parse(raw) as Partial<MockState>
    return {
      ...initialState(),
      ...stored,
      nfts: stored.nfts ?? initialState().nfts,
      versions: stored.versions ?? {},
      idempotency: stored.idempotency ?? {},
      userData: stored.userData ?? {
        [demoUser.id]: {
          favorites: stored.favorites ?? ['nft-003'],
          cart: stored.cart ?? [{ nftId: 'nft-002', quantity: 2 }],
          wallets: stored.wallets ?? [...demoWallets],
          orders: stored.orders ?? [...demoOrders],
        },
        [demoUserSecond.id]: createEmptyUserData(),
      },
      guestCart: stored.guestCart ?? [],
      accounts: stored.accounts ?? { [demoUser.email]: demoUser, [demoUserSecond.email]: demoUserSecond },
      passwordDigests: stored.passwordDigests ?? initialState().passwordDigests,
      sessionExpiresAt: stored.sessionExpiresAt ?? null,
      orderMode: stored.orderMode ?? 'success',
      networkMode: stored.networkMode ?? 'normal',
      failNextFavoriteMutation: stored.failNextFavoriteMutation ?? false,
    }
  } catch {
    return initialState()
  }
}

const writeState = (next: MockState) => {
  localStorage.setItem('jungle-marketplace-state', JSON.stringify(next))
}

const getAuthenticatedUser = (state = readState()) =>
  state.user && (state.sessionExpiresAt === null || state.sessionExpiresAt > Date.now())
    ? state.user
    : null

const getUserData = (state: MockState, userId: string) =>
  state.userData[userId] ?? createEmptyUserData()

const updateUserData = (
  state: MockState,
  userId: string,
  data: MockState['userData'][string],
): MockState => ({
  ...state,
  userData: { ...state.userData, [userId]: data },
  ...(state.user?.id === userId ? data : {}),
})

const mergeCart = (current: CartItem[], incoming: CartItem[]) => {
  const merged = new Map(current.map((item) => [item.nftId, item.quantity]))
  incoming.forEach((item) => merged.set(item.nftId, (merged.get(item.nftId) ?? 0) + item.quantity))
  return Array.from(merged, ([nftId, quantity]) => ({ nftId, quantity }))
}

const updateCart = (change: (cart: CartItem[]) => CartItem[]) => {
  const state = readState()
  const user = getAuthenticatedUser(state)
  if (!user) {
    const cart = change(state.guestCart)
    writeState({ ...state, guestCart: cart })
    return cart
  }
  const data = getUserData(state, user.id)
  const cart = change(data.cart)
  writeState(updateUserData(state, user.id, { ...data, cart }))
  return cart
}

const hashPassword = async (password: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

type MockSocket = ReturnType<typeof toSocketIo>
const socketClients = new Map<MockSocket, { userId: string | null }>()
const socketUrl = new URL('/', window.location.origin)
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const socketEndpoint = ws.link(socketUrl.toString())
const socketHandler = socketEndpoint.addEventListener('connection', (connection) => {
  const url = new URL(connection.client.url)
  if (!url.pathname.startsWith('/socket.io/') || url.searchParams.get('EIO') !== '4') {
    connection.server.connect()
    return
  }

  const socket = toSocketIo(connection)
  const session = { userId: getAuthenticatedUser()?.id ?? null }
  socket.client.on('session.join', () => {
    session.userId = getAuthenticatedUser()?.id ?? null
    socketClients.set(socket, session)
  })
  connection.client.addEventListener('close', () => socketClients.delete(socket))
})

const broadcast = (event: string, payload: unknown, userId?: string) => {
  for (const [socket, session] of socketClients) {
    if (userId && session.userId !== userId) continue
    socket.client.emit(event, payload)
  }
}

export const worker = setupWorker(
  http.all('*', async ({ request }) => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/__test/')) return

    const mode = readState().networkMode
    if (mode === 'normal') return
    if (mode === 'variable-latency') {
      const requestIndex = networkRequestCount++
      await delay(200 + (requestIndex % 4) * 300)
      return
    }
    if (mode === 'out-of-order') {
      if (!url.pathname.endsWith('/nfts') || !url.searchParams.has('search')) return
      const requestIndex = networkRequestCount++
      await delay(requestIndex % 2 === 0 ? 1_200 : 100)
      return
    }
    if (mode === 'timeout') {
      await delay(5_000)
      return
    }
    if (mode === 'offline') return HttpResponse.error()
    if (mode === 'http-4xx') {
      return HttpResponse.json({ message: 'Simulated network scenario: HTTP 429.' }, { status: 429 })
    }
    return HttpResponse.json({ message: 'Simulated network scenario: HTTP 503.' }, { status: 503 })
  }),
  socketHandler,
  http.get('/api/nfts', ({ request }) => {
    const url = new URL(request.url)
    const search = url.searchParams.get('search')?.trim().toLowerCase() ?? ''
    const category = url.searchParams.get('category') ?? 'all'
    const sort = url.searchParams.get('sort') ?? 'featured'
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') ?? '50')))

    const state = readState()
    let items = state.nfts
    if (search) {
      items = items.filter((nft) => `${nft.name} ${nft.collection} ${nft.artist}`.toLowerCase().includes(search))
    }
    if (category !== 'all') {
      items = items.filter((nft) => nft.category === category)
    }

    if (sort === 'price-low') {
      items = [...items].sort((a, b) => compareEth(a.price, b.price))
    }
    if (sort === 'price-high') {
      items = [...items].sort((a, b) => compareEth(b.price, a.price))
    }
    if (sort === 'trending') {
      items = [...items].sort((a, b) => b.likes - a.likes)
    }

    const total = items.length
    const pageItems = items.slice((page - 1) * limit, page * limit)
    return HttpResponse.json({ items: pageItems, total, page, limit, versions: state.versions })
  }),

  http.get('/api/nfts/:id', ({ params }) => {
    const nft = readState().nfts.find((item) => item.id === params.id)
    if (!nft) {
      return HttpResponse.json({ message: 'NFT not found' }, { status: 404 })
    }
    return HttpResponse.json({ nft })
  }),

  http.post('/api/login', async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string }
    const state = readState()
    const email = body.email?.trim().toLowerCase()

    if (!email || !body.password) {
      return HttpResponse.json({ message: 'Missing credentials' }, { status: 400 })
    }

    const user = state.accounts[email]
    const storedDigest = state.passwordDigests[email]
    if (!user || !storedDigest || (await hashPassword(body.password)) !== storedDigest) {
      return HttpResponse.json({ message: 'Invalid credentials' }, { status: 401 })
    }

    const currentData = getUserData(state, user.id)
    const merged = { ...currentData, cart: mergeCart(currentData.cart, state.guestCart) }
    const next = updateUserData(
      { ...state, user, guestCart: [], sessionExpiresAt: Date.now() + 8 * 60 * 60 * 1000 },
      user.id,
      merged,
    )
    writeState(next)
    return HttpResponse.json({ user, cart: merged.cart })
  }),

  http.post('/api/signup', async ({ request }) => {
    const body = (await request.json()) as { name: string; email: string; password: string }
    const email = body.email?.trim().toLowerCase()
    if (!body.name || !email || !body.password) {
      return HttpResponse.json({ message: 'Please complete the form' }, { status: 400 })
    }

    const state = readState()
    if (state.accounts[email]) {
      return HttpResponse.json({ message: 'An account with this email already exists' }, { status: 409 })
    }
    if (body.name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || body.password.length < 6) {
      return HttpResponse.json({ message: 'Enter a valid name, email, and password with at least 6 characters.' }, { status: 400 })
    }

    const user = {
      id: `u-${Date.now()}`,
      name: body.name,
      email,
      avatar: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=300&q=80',
      wallet: '0xB3E2...81AA',
    }
    const data = { ...createEmptyUserData(), cart: state.guestCart }
    const next = updateUserData({
      ...state,
      user,
      guestCart: [],
      accounts: { ...state.accounts, [user.email]: user },
      passwordDigests: { ...state.passwordDigests, [user.email]: await hashPassword(body.password) },
      sessionExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
    }, user.id, data)
    writeState(next)
    return HttpResponse.json({ user, cart: data.cart })
  }),

  http.get('/api/session', () => {
    const state = readState()
    if (state.user && state.sessionExpiresAt !== null && state.sessionExpiresAt <= Date.now()) {
      writeState({ ...state, user: null, sessionExpiresAt: null })
      return HttpResponse.json({ user: null })
    }
    return HttpResponse.json({ user: getAuthenticatedUser(state) })
  }),

  http.get('/api/profile', () => {
    const user = getAuthenticatedUser()
    if (!user) return HttpResponse.json({ message: 'Sign in to view your profile.' }, { status: 401 })
    return HttpResponse.json({ user })
  }),

  http.patch('/api/profile', async ({ request }) => {
    const body = (await request.json()) as { name: string; email: string; avatar: string }
    const state = readState()
    const currentUser = getAuthenticatedUser(state)
    if (!currentUser) return HttpResponse.json({ message: 'Sign in to update your profile.' }, { status: 401 })
    if (body.name.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return HttpResponse.json({ message: 'Enter a valid name and email address.' }, { status: 400 })
    }
    if (!/^https:\/\/\S+$/i.test(body.avatar)) {
      return HttpResponse.json({ message: 'Avatar must be a valid HTTPS URL.' }, { status: 400 })
    }
    const existing = state.accounts[body.email.trim().toLowerCase()]
    if (existing && existing.id !== currentUser.id) {
      return HttpResponse.json({ message: 'An account with this email already exists.' }, { status: 409 })
    }
    const email = body.email.trim().toLowerCase()
    const user = { ...currentUser, name: body.name.trim(), email, avatar: body.avatar.trim() }
    const accounts = { ...state.accounts }
    delete accounts[currentUser.email]
    accounts[user.email] = user
    const passwordDigests = { ...state.passwordDigests }
    if (currentUser.email !== user.email) {
      passwordDigests[user.email] = passwordDigests[currentUser.email]
      delete passwordDigests[currentUser.email]
    }
    writeState({ ...state, user, accounts, passwordDigests })
    return HttpResponse.json({ user })
  }),

  http.put('/api/profile/password', async ({ request }) => {
    const body = (await request.json()) as { currentPassword: string; newPassword: string }
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to update your password.' }, { status: 401 })
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 8) {
      return HttpResponse.json({ message: 'Enter your current password and a new password with at least 8 characters.' }, { status: 400 })
    }
    if ((await hashPassword(body.currentPassword)) !== state.passwordDigests[user.email]) {
      return HttpResponse.json({ message: 'Current password is incorrect.' }, { status: 400 })
    }
    writeState({
      ...state,
      passwordDigests: { ...state.passwordDigests, [user.email]: await hashPassword(body.newPassword) },
    })
    return HttpResponse.json({ success: true })
  }),

  http.get('/api/cart', () => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    return HttpResponse.json({ cart: user ? getUserData(state, user.id).cart : state.guestCart })
  }),

  http.post('/api/cart', async ({ request }) => {
    const body = (await request.json()) as { nftId: string; quantity: number }
    if (!body.nftId || !Number.isSafeInteger(body.quantity) || body.quantity < 1) {
      return HttpResponse.json({ message: 'Choose a valid NFT and a positive whole-number quantity.' }, { status: 400 })
    }
    const state = readState()
    const nft = state.nfts.find((entry) => entry.id === body.nftId)
    if (!nft) return HttpResponse.json({ message: 'NFT not found.' }, { status: 404 })
    try {
      const cart = updateCart((current) => {
        const currentQty = current.find((item) => item.nftId === body.nftId)?.quantity ?? 0
        const quantity = currentQty + body.quantity
        if (quantity > nft.available) throw new RangeError(`Only ${nft.available} editions are available.`)
        return currentQty
          ? current.map((item) => item.nftId === body.nftId ? { ...item, quantity } : item)
          : [...current, { nftId: body.nftId, quantity }]
      })
      return HttpResponse.json({ cart })
    } catch (error: unknown) {
      return HttpResponse.json({ message: error instanceof Error ? error.message : 'Unable to update the cart.' }, { status: 409 })
    }
  }),

  http.put('/api/cart/:nftId', async ({ params, request }) => {
    const body = (await request.json()) as { quantity: number }
    if (!Number.isSafeInteger(body.quantity) || body.quantity < 0) {
      return HttpResponse.json({ message: 'Quantity must be a non-negative whole number.' }, { status: 400 })
    }
    const state = readState()
    const nft = state.nfts.find((entry) => entry.id === params.nftId)
    if (body.quantity > 0 && !nft) return HttpResponse.json({ message: 'NFT not found.' }, { status: 404 })
    if (nft && body.quantity > nft.available) {
      return HttpResponse.json({ message: `Only ${nft.available} editions are available.` }, { status: 409 })
    }
    const cart = updateCart((current) => current
      .map((item) => (item.nftId === params.nftId ? { ...item, quantity: body.quantity } : item))
      .filter((item) => item.quantity > 0)
    )
    return HttpResponse.json({ cart })
  }),

  http.delete('/api/cart/:nftId', ({ params }) => {
    const cart = updateCart((current) => current.filter((item) => item.nftId !== params.nftId))
    return HttpResponse.json({ cart })
  }),

  http.get('/api/favorites', () => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to view favorites.' }, { status: 401 })
    return HttpResponse.json({ favorites: getUserData(state, user.id).favorites })
  }),

  http.post('/api/favorites/:nftId', ({ params }) => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to save favorites.' }, { status: 401 })
    if (state.failNextFavoriteMutation) {
      writeState({ ...state, failNextFavoriteMutation: false })
      return HttpResponse.json({ message: 'Favorite update failed' }, { status: 503 })
    }
    const nftId = params.nftId as string
    if (!state.nfts.some((nft) => nft.id === nftId)) return HttpResponse.json({ message: 'NFT not found.' }, { status: 404 })
    const data = getUserData(state, user.id)
    const favorites = data.favorites.includes(nftId) ? data.favorites : [...data.favorites, nftId]
    const updated = updateUserData(state, user.id, { ...data, favorites })
    writeState(updated)
    return HttpResponse.json({ favorites })
  }),

  http.delete('/api/favorites/:nftId', ({ params }) => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to remove favorites.' }, { status: 401 })
    const data = getUserData(state, user.id)
    const favorites = data.favorites.filter((id) => id !== params.nftId)
    writeState(updateUserData(state, user.id, { ...data, favorites }))
    return HttpResponse.json({ favorites })
  }),

  http.get('/api/wallets', () => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to view wallets.' }, { status: 401 })
    return HttpResponse.json({ wallets: getUserData(state, user.id).wallets })
  }),

  http.post('/api/wallets', async ({ request }) => {
    const body = (await request.json()) as { label: string; address: string; network: string }
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to manage wallets.' }, { status: 401 })
    if (!body.label?.trim() || !body.address?.trim() || !['Ethereum', 'Polygon', 'Solana'].includes(body.network)) {
      return HttpResponse.json({ message: 'Enter a wallet label, address, and supported network.' }, { status: 400 })
    }
    const data = getUserData(state, user.id)
    if (data.wallets.some((wallet) => wallet.address.toLowerCase() === body.address.trim().toLowerCase())) {
      return HttpResponse.json({ message: 'This wallet address is already saved.' }, { status: 409 })
    }
    const newWallet: Wallet = {
      id: `w-${crypto.randomUUID()}`,
      label: body.label.trim(),
      address: body.address.trim(),
      network: body.network as 'Ethereum' | 'Polygon' | 'Solana',
      isPrimary: data.wallets.length === 0,
    }
    const wallets = [...data.wallets, newWallet]
    writeState(updateUserData(state, user.id, { ...data, wallets }))
    return HttpResponse.json({ wallets, wallet: newWallet })
  }),

  http.put('/api/wallets/:walletId', async ({ params, request }) => {
    const body = (await request.json()) as { label: string; address: string; network: string }
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to manage wallets.' }, { status: 401 })
    if (!body.label?.trim() || !body.address?.trim() || !['Ethereum', 'Polygon', 'Solana'].includes(body.network)) {
      return HttpResponse.json({ message: 'Enter a wallet label, address, and supported network.' }, { status: 400 })
    }
    const data = getUserData(state, user.id)
    const existing = data.wallets.find((wallet) => wallet.id === params.walletId)
    if (!existing) return HttpResponse.json({ message: 'Wallet not found.' }, { status: 404 })
    if (data.wallets.some((wallet) => wallet.id !== existing.id && wallet.address.toLowerCase() === body.address.trim().toLowerCase())) {
      return HttpResponse.json({ message: 'This wallet address is already saved.' }, { status: 409 })
    }
    const wallet = { ...existing, label: body.label.trim(), address: body.address.trim(), network: body.network as Wallet['network'] }
    const wallets = data.wallets.map((entry) => entry.id === wallet.id ? wallet : entry)
    writeState(updateUserData(state, user.id, { ...data, wallets }))
    return HttpResponse.json({ wallet, wallets })
  }),

  http.patch('/api/wallets/:walletId/primary', ({ params }) => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to manage wallets.' }, { status: 401 })
    const data = getUserData(state, user.id)
    if (!data.wallets.some((wallet) => wallet.id === params.walletId)) {
      return HttpResponse.json({ message: 'Wallet not found.' }, { status: 404 })
    }
    const wallets = data.wallets.map((wallet) => ({ ...wallet, isPrimary: wallet.id === params.walletId }))
    writeState(updateUserData(state, user.id, { ...data, wallets }))
    return HttpResponse.json({ wallets })
  }),

  http.delete('/api/wallets/:walletId', ({ params }) => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to manage wallets.' }, { status: 401 })
    const data = getUserData(state, user.id)
    const selected = data.wallets.find((wallet) => wallet.id === params.walletId)
    if (!selected) return HttpResponse.json({ message: 'Wallet not found.' }, { status: 404 })
    let wallets = data.wallets.filter((wallet) => wallet.id !== selected.id)
    if (selected.isPrimary && wallets.length > 0) {
      wallets = wallets.map((wallet, index) => ({ ...wallet, isPrimary: index === 0 }))
    }
    writeState(updateUserData(state, user.id, { ...data, wallets }))
    return HttpResponse.json({ wallets })
  }),

  http.post('/api/coupons/validate', async ({ request }) => {
    const body = (await request.json()) as { code: string }
    const code = body.code?.toUpperCase()
    if (code === 'WELCOME10') {
      return HttpResponse.json({ valid: true, discount: 0.1, label: 'WELCOME10' })
    }
    return HttpResponse.json({ valid: false, message: 'Coupon expired or invalid' }, { status: 400 })
  }),

  http.post('/api/quote', async ({ request }) => {
    const body = (await request.json()) as { items: CartItem[]; couponCode?: string }
    const state = readState()
    try {
      return HttpResponse.json(calculateQuote(state.nfts, body.items, body.couponCode))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to quote this cart.'
      const status = message.startsWith('Coupon') ? 400 : message.includes('no longer available') || message.includes('only ') ? 409 : 400
      return HttpResponse.json({ message }, { status })
    }
  }),

  http.get('/api/orders/:orderId', ({ params }) => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to view orders.' }, { status: 401 })
    const order = getUserData(state, user.id).orders.find((entry) => entry.id === params.orderId)
    if (!order) return HttpResponse.json({ message: 'Order not found' }, { status: 404 })
    return HttpResponse.json({ order })
  }),

  http.get('/api/orders', () => {
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Sign in to view orders.' }, { status: 401 })
    return HttpResponse.json({ orders: getUserData(state, user.id).orders })
  }),

  http.post('/api/logout', () => {
    const state = readState()
    writeState({ ...state, user: null, sessionExpiresAt: null })
    return HttpResponse.json({ success: true })
  }),

  http.post('/api/__test/reset', () => {
    if (import.meta.env.VITE_MOCK_SCENARIOS !== 'true') {
      return HttpResponse.json({ message: 'Mock scenarios are disabled' }, { status: 404 })
    }
    const state = initialState()
    networkRequestCount = 0
    writeState(state)
    return HttpResponse.json({ success: true })
  }),

  http.get('/api/__test/status', () => {
    if (import.meta.env.VITE_MOCK_SCENARIOS !== 'true') {
      return HttpResponse.json({ message: 'Mock scenarios are disabled' }, { status: 404 })
    }
    return HttpResponse.json({ socketClients: socketClients.size, networkMode: readState().networkMode })
  }),

  http.post('/api/__test/network-mode', async ({ request }) => {
    if (import.meta.env.VITE_MOCK_SCENARIOS !== 'true') {
      return HttpResponse.json({ message: 'Mock scenarios are disabled' }, { status: 404 })
    }
    const body = (await request.json()) as { mode: MockState['networkMode'] }
    const supportedModes: MockState['networkMode'][] = [
      'normal',
      'variable-latency',
      'out-of-order',
      'timeout',
      'offline',
      'http-4xx',
      'http-5xx',
    ]
    if (!supportedModes.includes(body.mode)) {
      return HttpResponse.json({ message: 'Invalid network scenario' }, { status: 400 })
    }
    const state = readState()
    networkRequestCount = 0
    writeState({ ...state, networkMode: body.mode })
    return HttpResponse.json({ networkMode: body.mode })
  }),

  http.post('/api/__test/session-expiry', () => {
    if (import.meta.env.VITE_MOCK_SCENARIOS !== 'true') {
      return HttpResponse.json({ message: 'Mock scenarios are disabled' }, { status: 404 })
    }
    const state = readState()
    writeState({ ...state, sessionExpiresAt: Date.now() - 1 })
    return HttpResponse.json({ success: true })
  }),

  http.post('/api/__test/order-mode', async ({ request }) => {
    if (import.meta.env.VITE_MOCK_SCENARIOS !== 'true') {
      return HttpResponse.json({ message: 'Mock scenarios are disabled' }, { status: 404 })
    }
    const body = (await request.json()) as { mode: MockState['orderMode'] }
    if (!['success', 'payment-failure', 'timeout'].includes(body.mode)) {
      return HttpResponse.json({ message: 'Invalid order scenario' }, { status: 400 })
    }
    const state = readState()
    writeState({ ...state, orderMode: body.mode })
    return HttpResponse.json({ success: true })
  }),

  http.post('/api/__test/fail-next-favorite', () => {
    if (import.meta.env.VITE_MOCK_SCENARIOS !== 'true') {
      return HttpResponse.json({ message: 'Mock scenarios are disabled' }, { status: 404 })
    }
    const state = readState()
    writeState({ ...state, failNextFavoriteMutation: true })
    return HttpResponse.json({ success: true })
  }),

  http.post('/api/__test/events', async ({ request }) => {
    if (import.meta.env.VITE_MOCK_SCENARIOS !== 'true') {
      return HttpResponse.json({ message: 'Mock scenarios are disabled' }, { status: 404 })
    }
    const body = (await request.json()) as {
      type: 'nft.updated' | 'order.updated'
      resourceId: string
      version?: number
      data?: Partial<NFT> | Partial<Order>
      duplicate?: boolean
    }
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Your session has expired. Sign in again.' }, { status: 401 })
    const currentVersion = state.versions[body.resourceId] ?? 0
    const version = body.version ?? currentVersion + 1
    const isStale = version <= currentVersion
    let event: Record<string, unknown>

    if (body.type === 'nft.updated') {
      const currentNft = state.nfts.find((nft) => nft.id === body.resourceId)
      if (!currentNft) return HttpResponse.json({ message: 'NFT not found' }, { status: 404 })
      const nextNft = { ...currentNft, ...(body.data as Partial<NFT>) }
      if (!isStale) {
        state.nfts = state.nfts.map((nft) => nft.id === nextNft.id ? nextNft : nft)
      }
      event = {
        eventId: `nft-${nextNft.id}-v${version}`,
        resourceId: nextNft.id,
        version,
        data: nextNft,
      }
    } else {
      const currentData = getUserData(state, user.id)
      const currentOrder = currentData.orders.find((order) => order.id === body.resourceId)
      if (!currentOrder) return HttpResponse.json({ message: 'Order not found' }, { status: 404 })
      const nextOrder = { ...currentOrder, ...(body.data as Partial<Order>) }
      if (!isStale) {
        const orders = currentData.orders.map((order) => order.id === nextOrder.id ? nextOrder : order)
        Object.assign(state, updateUserData(state, user.id, { ...currentData, orders }))
      }
      event = {
        eventId: `order-${nextOrder.id}-v${version}`,
        resourceId: nextOrder.id,
        userId: user.id,
        version,
        data: nextOrder,
      }
    }

    if (!isStale) {
      state.versions[body.resourceId] = version
      writeState(state)
    }
    broadcast(body.type, event, body.type === 'order.updated' ? user.id : undefined)
    if (body.duplicate) broadcast(body.type, event, body.type === 'order.updated' ? user.id : undefined)
    return HttpResponse.json({ event })
  }),

  http.post('/api/orders', async ({ request }) => {
    const body = (await request.json()) as {
      items: Array<{ nftId: string; quantity: number; price: string }>
      total: string
      couponCode?: string
      idempotencyKey?: string
    }
    const state = readState()
    const user = getAuthenticatedUser(state)
    if (!user) return HttpResponse.json({ message: 'Your session has expired. Sign in again.' }, { status: 401 })
    if (!body.idempotencyKey?.trim()) {
      return HttpResponse.json({ message: 'An idempotency key is required for every checkout attempt.' }, { status: 400 })
    }
    const userData = getUserData(state, user.id)
    const idempotencyKey = `${user.id}:${body.idempotencyKey}`
    const fingerprint = JSON.stringify({ items: body.items, total: body.total, couponCode: body.couponCode ?? null })
    if (state.idempotency[idempotencyKey]) {
      const existing = state.idempotency[idempotencyKey]
      if (existing.fingerprint !== fingerprint) {
        return HttpResponse.json({ message: 'Idempotency key conflict' }, { status: 409 })
      }
      return HttpResponse.json({ order: existing.order, cart: userData.cart })
    }
    let quote: ReturnType<typeof calculateQuote>
    try {
      quote = calculateQuote(state.nfts, body.items, body.couponCode)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to validate the order.'
      const status = message.startsWith('Coupon') ? 400 : message.includes('no longer available') || message.includes('only ') ? 409 : 400
      return HttpResponse.json({ message }, { status })
    }
    if (body.items.some((item, index) => item.price !== quote.items[index]?.price) || body.total !== quote.total) {
      return HttpResponse.json({ message: 'The checkout quote changed. Review the current price and fees.' }, { status: 409 })
    }
    const refused = state.orderMode === 'payment-failure'
    const order: Order = {
    id: `ord-${crypto.randomUUID()}`,
    status: refused ? 'refused' : state.orderMode === 'timeout' ? 'pending' : 'confirmed',
    total: quote.total,
    currency: 'ETH',
    items: quote.items,
    txHash: refused ? '' : `0x${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: new Date().toISOString(),
    }
    let nextData = {
    ...userData,
    orders: [order, ...userData.orders],
    }
    let nextState = updateUserData({
    ...state,
    idempotency: { ...state.idempotency, [idempotencyKey]: { fingerprint, order } },
    nfts: refused ? state.nfts : state.nfts.map((nft) => {
      const purchased = quote.items.find((item) => item.nftId === nft.id)
      return purchased ? { ...nft, available: nft.available - purchased.quantity } : nft
    }),
    }, user.id, nextData)

    if (!refused && order.status === 'confirmed') {
    nextData = {
      ...nextData,
      cart: nextData.cart
      .map((item) => {
        const purchased = quote.items.find((entry) => entry.nftId === item.nftId)
        return purchased ? { ...item, quantity: item.quantity - purchased.quantity } : item
      })
      .filter((item) => item.quantity > 0),
    }
    nextState = updateUserData(nextState, user.id, nextData)
    }
    writeState(nextState)

    const publishOrder = (version: number, currentOrder: Order) => broadcast('order.updated', {
    eventId: `order-${currentOrder.id}-v${version}`,
    resourceId: currentOrder.id,
    userId: user.id,
    version,
    data: currentOrder,
    }, user.id)

    let version = (state.versions[order.id] ?? 0) + 1
    nextState.versions[order.id] = version
    writeState(nextState)
    publishOrder(version, order)

    if (state.orderMode === 'timeout') {
    await new Promise((resolve) => setTimeout(resolve, 4500))
    const currentState = readState()
    const currentData = getUserData(currentState, user.id)
    const confirmed: Order = { ...order, status: 'confirmed' }
    const confirmedData = {
      ...currentData,
      orders: currentData.orders.map((entry) => entry.id === order.id ? confirmed : entry),
      cart: currentData.cart
        .map((item) => {
          const purchased = quote.items.find((entry) => entry.nftId === item.nftId)
          return purchased ? { ...item, quantity: item.quantity - purchased.quantity } : item
        })
        .filter((item) => item.quantity > 0),
    }
    const finalState = updateUserData(currentState, user.id, {
      ...confirmedData,
    })
    finalState.idempotency[idempotencyKey] = { fingerprint, order: confirmed }
    version += 1
    finalState.versions[order.id] = version
    writeState(finalState)
    publishOrder(version, confirmed)
    return HttpResponse.json({ order: confirmed, cart: confirmedData.cart })
    }

    return HttpResponse.json({ order, cart: nextData.cart })
  }),
)

export const startMocks = async () => {
  await worker.start({
    serviceWorker: {
      url: '/mockServiceWorker.js',
    },
    onUnhandledRequest(request) {
      if (request.url.startsWith('https://images.unsplash.com')) return
      const requestPath = new URL(request.url).pathname
      if (requestPath.startsWith('/socket.io') || requestPath.startsWith('/__test/socket-')) return
      if (request.mode === 'navigate') return
      console.warn('[MSW] unhandled request:', request.method, request.url)
    },
    quiet: true,
  })
}
