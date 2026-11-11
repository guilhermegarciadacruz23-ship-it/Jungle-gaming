import { useEffect, useRef, useState } from 'react'
import {
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { ArrowLeft, Heart, Menu, Minus, Plus, Search, ShieldCheck, ShoppingCart, Star, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Socket } from 'socket.io-client'
import { api, formatEth } from './lib/api'
import { multiplyEth } from './lib/eth'
import { MarketplaceContext, useMarketplace } from './lib/marketplace-context'
import type { MarketplaceContextValue } from './lib/marketplace-context'
import type { Quote } from './lib/quote'
import type { CartItem, NFT, Order, User, Wallet as WalletType } from './types'
import type { NftUpdatedEvent, OrderUpdatedEvent } from './lib/realtime'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const readStorage = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const getSearchParam = (href: string, key: string, fallback = '') => {
  const value = new URL(href, window.location.origin).searchParams.get(key)
  if (value === null) return fallback
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' || typeof parsed === 'number' ? String(parsed) : value
  } catch {
    return value
  }
}

const getSafeReturnPath = (href: string) => {
  const destination = new URL(getSearchParam(href, 'redirect', '/'), window.location.origin)
  return destination.origin === window.location.origin && !['/login', '/signup'].includes(destination.pathname)
    ? `${destination.pathname}${destination.search}${destination.hash}`
    : '/'
}

const getApiErrorMessage = (error: unknown, fallback: string) => {
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && error.code === 'ECONNABORTED') {
      return 'The payment request timed out. Your cart is preserved; retry safely.'
    }
    if ('response' in error) {
      const response = error.response
      if (typeof response === 'object' && response !== null && 'data' in response) {
        const data = response.data
        if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
          return data.message
        }
      }
    }
  }
  return error instanceof Error ? error.message : fallback
}

const getApiErrorStatus = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined
  const response = error.response
  return typeof response === 'object' && response !== null && 'status' in response
    ? response.status
    : undefined
}

function App() {
  const queryClient = useQueryClient()
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: async () => (await api.get<{ user: User | null }>('/session')).data,
  })
  const user = sessionQuery.data?.user ?? null
  const userId = user?.id ?? 'guest'
  const cartKey = ['cart', userId] as const
  const favoritesKey = ['favorites', userId] as const
  const walletsKey = ['wallets', userId] as const
  const ordersKey = ['orders', userId] as const
  const cartQuery = useQuery({
    queryKey: cartKey,
    queryFn: async () => (await api.get<{ cart: CartItem[] }>('/cart')).data.cart,
  })
  const favoritesQuery = useQuery({
    queryKey: favoritesKey,
    queryFn: async () => (await api.get<{ favorites: string[] }>('/favorites')).data.favorites,
    enabled: Boolean(user),
  })
  const walletsQuery = useQuery({
    queryKey: walletsKey,
    queryFn: async () => (await api.get<{ wallets: WalletType[] }>('/wallets')).data.wallets,
    enabled: Boolean(user),
  })
  const ordersQuery = useQuery({
    queryKey: ordersKey,
    queryFn: async () => (await api.get<{ orders: Order[] }>('/orders')).data.orders,
    enabled: Boolean(user),
  })
  const cart = cartQuery.data ?? []
  const favorites = favoritesQuery.data ?? []
  const wallets = walletsQuery.data ?? []
  const orders = ordersQuery.data ?? []
  const setCart: React.Dispatch<React.SetStateAction<CartItem[]>> = (updater) => {
    queryClient.setQueryData<CartItem[]>(cartKey, (current = []) =>
      typeof updater === 'function' ? updater(current) : updater,
    )
  }
  const setOrders: React.Dispatch<React.SetStateAction<Order[]>> = (updater) => {
    queryClient.setQueryData<Order[]>(ordersKey, (current = []) =>
      typeof updater === 'function' ? updater(current) : updater,
    )
  }
  const [realtimeNotice, setRealtimeNotice] = useState('')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const eventVersions = useRef(new Map<string, number>())
  const [nftRevision, setNftRevision] = useState(0)

  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    void import('./lib/realtime').then(({ createMarketplaceSocket }) => {
    if (disposed) return
    const socket: Socket = createMarketplaceSocket()
    socket.on('connect_error', (error) => {
      console.error('Marketplace realtime connection failed.', error.message)
    })
    const updateCachedNft = (nft: NFT) => {
      queryClient.setQueriesData<{ items: NFT[] }>(
        {
          predicate: ({ queryKey }) => queryKey[0] === 'nfts',
        },
        (current) => current
          ? { ...current, items: current.items.map((entry) => entry.id === nft.id ? nft : entry) }
          : current,
      )
      queryClient.setQueriesData<NFT[]>(
        {
          predicate: ({ queryKey }) => ['nfts-all', 'nfts-all-2'].includes(String(queryKey[0])),
        },
        (current) => current?.map((entry) => entry.id === nft.id ? nft : entry),
      )
      queryClient.setQueryData<NFT>(['nft', nft.id], (current) => current ? { ...current, ...nft } : current)
    }

    socket.on('connect', () => {
      socket.emit('session.join')
      void api.get('/nfts').then(({ data }) => {
        const items = data.items as NFT[]
        Object.entries(data.versions as Record<string, number>).forEach(([id, version]) => {
          eventVersions.current.set(id, Math.max(eventVersions.current.get(id) ?? 0, version))
        })
        items.forEach(updateCachedNft)
      }).catch((error: unknown) => {
        console.error('Unable to reconcile marketplace data after reconnect.', error)
      })
      void Promise.all(
        (queryClient.getQueryData<Order[]>(['orders', userId]) ?? [])
          .filter((order) => order.status === 'pending')
          .map(async (order) => {
          const response = await api.get(`/orders/${order.id}`)
          queryClient.setQueryData<Order[]>(['orders', userId], (current = []) =>
            current.map((entry) => entry.id === order.id ? response.data.order as Order : entry),
          )
        }),
      ).catch((error: unknown) => {
        console.error('Unable to reconcile pending orders after reconnect.', error)
      })
    })

    socket.on('nft.updated', (event: NftUpdatedEvent) => {
      const lastVersion = eventVersions.current.get(event.resourceId) ?? 0
      if (!event.eventId || event.version <= lastVersion || event.data.id !== event.resourceId) return
      eventVersions.current.set(event.resourceId, event.version)
      updateCachedNft(event.data)
      setNftRevision((revision) => revision + 1)
      setRealtimeNotice(`${event.data.name} changed. Its price and availability are up to date.`)
    })

    socket.on('order.updated', (event: OrderUpdatedEvent) => {
      if (!userId || event.userId !== userId || event.data.id !== event.resourceId) return
      const lastVersion = eventVersions.current.get(event.resourceId) ?? 0
      if (!event.eventId || event.version <= lastVersion) return
      eventVersions.current.set(event.resourceId, event.version)
      queryClient.setQueryData<Order[]>(['orders', userId], (current = []) => {
        const existing = current.find((order) => order.id === event.resourceId)
        if (existing && existing.status !== 'pending' && event.data.status !== existing.status) return current
        return existing
          ? current.map((order) => order.id === event.resourceId ? event.data : order)
          : [event.data, ...current]
      })
      setRealtimeNotice(`Order ${event.resourceId} is ${event.data.status}.`)
    })

    cleanup = () => {
      socket.removeAllListeners()
      socket.disconnect()
    }
    }).catch((error: unknown) => {
      console.error('Unable to load marketplace realtime support.', error)
    })

    return () => {
      disposed = true
      cleanup()
    }
  }, [queryClient, userId])

  const handleSessionExpired = async () => {
    if (user) {
      queryClient.removeQueries({
        predicate: ({ queryKey }) =>
          ['cart', 'favorites', 'wallets', 'orders', 'order'].includes(String(queryKey[0])) &&
          queryKey[1] === user.id,
      })
    }
    queryClient.setQueryData(['session'], { user: null })
    await queryClient.refetchQueries({ queryKey: ['session'], exact: true })
  }

  const handleLogout = async () => {
    try {
      await api.post('/logout')
    } catch (error: unknown) {
      console.error('Unable to end the mock session.', error)
    } finally {
      await handleSessionExpired()
      queryClient.setQueryData(['cart', 'guest'], [])
    }
  }

  const addToCart = async (nftId: string, quantity: number) => {
    const previousCart = cart
    const next = cart.some((item) => item.nftId === nftId)
      ? cart.map((item) => (item.nftId === nftId ? { ...item, quantity: item.quantity + quantity } : item))
      : [...cart, { nftId, quantity }]
    setCart(next)

    try {
      const response = await api.post('/cart', { nftId, quantity })
      setCart(response.data.cart as CartItem[])
    } catch (error: unknown) {
      setCart(previousCart)
      setRealtimeNotice('Unable to add this item. Your cart was restored.')
      console.error('Unable to add item to cart.', error)
    }
  }

  const removeFromCart = async (nftId: string) => {
    const previousCart = cart
    setCart((current) => current.filter((item) => item.nftId !== nftId))
    try {
      const response = await api.delete(`/cart/${nftId}`)
      setCart(response.data.cart as CartItem[])
    } catch (error: unknown) {
      setCart(previousCart)
      setRealtimeNotice('Unable to remove this item. Your cart was restored.')
      console.error('Unable to remove item from cart.', error)
    }
  }

  const updateCartQty = async (nftId: string, quantity: number) => {
    if (quantity <= 0) {
      await removeFromCart(nftId)
      return
    }

    const previousCart = cart
    setCart((current) => current.map((item) => (item.nftId === nftId ? { ...item, quantity } : item)))
    try {
      const response = await api.put(`/cart/${nftId}`, { quantity })
      setCart(response.data.cart as CartItem[])
    } catch (error: unknown) {
      setCart(previousCart)
      setRealtimeNotice('Unable to update the quantity. Your cart was restored.')
      console.error('Unable to update cart quantity.', error)
    }
  }

  const toggleFavorite = async (nftId: string) => {
    const previous = favorites
    const next = favorites.includes(nftId)
      ? favorites.filter((item) => item !== nftId)
      : [...favorites, nftId]
    queryClient.setQueryData<string[]>(favoritesKey, next)

    try {
      const response = previous.includes(nftId)
        ? await api.delete(`/favorites/${nftId}`)
        : await api.post(`/favorites/${nftId}`)
      queryClient.setQueryData<string[]>(favoritesKey, response.data.favorites)
    } catch (error: unknown) {
      queryClient.setQueryData<string[]>(favoritesKey, previous)
      setRealtimeNotice('Unable to update favorites. Your previous selection was restored.')
      console.error('Unable to update favorites.', error)
    }
  }

  const handleLogin = async (email: string, password: string) => {
    const response = await api.post('/login', { email, password })
    const nextUser = response.data.user as User
    queryClient.setQueryData(['session'], { user: nextUser })
    queryClient.setQueryData<CartItem[]>(['cart', nextUser.id], response.data.cart ?? [])
    return nextUser
  }

  const handleSignup = async (payload: { name: string; email: string; password: string }) => {
    const response = await api.post('/signup', payload)
    const nextUser = response.data.user as User
    queryClient.setQueryData(['session'], { user: nextUser })
    queryClient.setQueryData<CartItem[]>(['cart', nextUser.id], response.data.cart ?? [])
    return nextUser
  }

  const updateProfile = async (payload: { name: string; email: string; avatar: string }) => {
    const response = await api.patch('/profile', payload)
    const nextUser = response.data.user as User
    queryClient.setQueryData(['session'], { user: nextUser })
    return nextUser
  }

  const updatePassword = async (payload: { currentPassword: string; newPassword: string }) => {
    await api.put('/profile/password', payload)
  }

  const saveWallet = async (
    walletId: string | null,
    payload: Omit<WalletType, 'id' | 'isPrimary'>,
  ) => {
    const response = walletId
      ? await api.put(`/wallets/${walletId}`, payload)
      : await api.post('/wallets', payload)
    queryClient.setQueryData<WalletType[]>(walletsKey, response.data.wallets)
  }

  const removeWallet = async (walletId: string) => {
    const response = await api.delete(`/wallets/${walletId}`)
    queryClient.setQueryData<WalletType[]>(walletsKey, response.data.wallets)
  }

  const setPrimaryWallet = async (walletId: string) => {
    const response = await api.patch(`/wallets/${walletId}/primary`)
    queryClient.setQueryData<WalletType[]>(walletsKey, response.data.wallets)
  }

  const handleOrder = async (
    items: Array<{ nftId: string; quantity: number; price: string }>,
    total: string,
    couponCode: string | undefined,
    idempotencyKey: string,
  ) => {
    const response = await api.post('/orders', { items, total, couponCode, idempotencyKey })
    const nextOrder = response.data.order as Order
    setOrders((current) => [nextOrder, ...current.filter((entry) => entry.id !== nextOrder.id)])
    setCart((response.data.cart as CartItem[] | undefined) ?? [])
    if (nextOrder.status === 'confirmed') localStorage.removeItem('jungle-coupon')
    return nextOrder
  }

  const rootRoute = createRootRoute({
    validateSearch: (search: Record<string, unknown>) => ({
      search: typeof search.search === 'string' ? search.search : '',
      category: typeof search.category === 'string' ? search.category : 'all',
      sort: typeof search.sort === 'string' ? search.sort : 'featured',
      page: Number.isSafeInteger(Number(search.page)) && Number(search.page) > 0
        ? Number(search.page)
        : 1,
      redirect: typeof search.redirect === 'string' ? search.redirect : '/',
    }),
    notFoundComponent: () => (
      <div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-slate-900/80 p-10 text-center">
        <h1 className="text-3xl font-bold text-white">Page not found</h1>
        <p className="mt-3 text-slate-300">The page you requested does not exist.</p>
        <Link to="/" className="mt-6 inline-flex rounded-full bg-violet-600 px-5 py-3 font-medium text-white">Return to marketplace</Link>
      </div>
    ),
    component: function RootLayout() {
      const {
        user,
        cart,
        handleLogout,
        mobileNavOpen,
        setMobileNavOpen,
        realtimeNotice,
      } = useMarketplace()
      const navigate = useNavigate()
      const routerState = useRouterState()
      const handleHeaderSearch = (value: string) => {
        const next = new URLSearchParams(window.location.search)
        const cleaned = value.trim()
        next.delete('page')
        if (cleaned) next.set('search', cleaned)
        else next.delete('search')
        void navigate({ to: '/', search: Object.fromEntries(next.entries()) })
      }
      return (
      <div className="jungle-app">
        <header className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
            <Link to="/" className="flex items-center gap-3 text-lg font-semibold tracking-[0.16em] text-white">
              <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-violet-600 text-sm font-black text-slate-950">
                K
              </div>
              KURIO
            </Link>

            <nav className="hidden items-center gap-8 text-sm text-slate-300 lg:flex">
              <Link to="/" activeProps={{ className: 'text-white' }} className="text-slate-300 transition hover:text-white">
                Início
              </Link>
              <Link to="/wallets" activeProps={{ className: 'text-white' }} className="text-slate-300 transition hover:text-white">
                Carteiras
              </Link>
              <Link to="/profile" activeProps={{ className: 'text-white' }} className="text-slate-300 transition hover:text-white">
                Criadores
              </Link>
              <Link to="/" hash="marketplace" className="text-slate-300 transition hover:text-white">
                Mercado
              </Link>
            </nav>

            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
                aria-expanded={mobileNavOpen}
                aria-controls="mobile-navigation"
                onClick={() => setMobileNavOpen((open) => !open)}
                className="rounded-full border border-white/10 bg-white/5 p-2.5 text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300 lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>
              <label className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 lg:flex">
                <Search className="h-4 w-4" />
                <input
                  aria-label="Search NFTs"
                  value={getSearchParam(routerState.location.href, 'search')}
                  onChange={(event) => handleHeaderSearch(event.target.value)}
                  placeholder="Buscar NFTs"
                  className="w-28 bg-transparent text-sm text-white placeholder:text-slate-400 focus:outline-none"
                />
              </label>
              <Link to="/cart" className="relative rounded-full border border-white/10 bg-white/5 p-2.5 text-slate-200">
                <ShoppingCart className="h-5 w-5" />
                {cart.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-violet-500 px-1 text-[10px] font-bold">
                    {cart.reduce((sum, item) => sum + item.quantity, 0)}
                  </span>
                )}
              </Link>
              {user ? (
                <div className="flex items-center gap-2">
                  <Link to="/profile" className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2 py-2 text-sm text-slate-100 sm:px-3">
                    <img src={user.avatar} alt={user.name} className="h-7 w-7 rounded-full object-cover" />
                    <span className="hidden sm:inline">{user.name.split(' ')[0]}</span>
                  </Link>
                  <button type="button" aria-label="Logout" onClick={handleLogout} className="hidden rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 sm:inline-flex">
                    Sair
                  </button>
                </div>
              ) : (
                <Link to="/login" aria-label="Login" className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-violet-500/20">
                  Entrar
                </Link>
              )}
            </div>
          </div>
          {mobileNavOpen && (
            <nav id="mobile-navigation" aria-label="Mobile navigation" className="mx-auto flex max-w-7xl flex-col gap-1 px-4 pb-4 sm:px-6 lg:hidden">
              <Link to="/" onClick={() => setMobileNavOpen(false)} className="rounded-xl px-3 py-2 text-sm text-slate-200 hover:bg-white/5">Início</Link>
              <Link to="/" hash="marketplace" onClick={() => setMobileNavOpen(false)} className="rounded-xl px-3 py-2 text-sm text-slate-200 hover:bg-white/5">Mercado</Link>
              <Link to="/wallets" aria-label="Wallets" onClick={() => setMobileNavOpen(false)} className="rounded-xl px-3 py-2 text-sm text-slate-200 hover:bg-white/5">Carteiras</Link>
              <Link to="/profile" onClick={() => setMobileNavOpen(false)} className="rounded-xl px-3 py-2 text-sm text-slate-200 hover:bg-white/5">Criadores</Link>
              {user && <button type="button" onClick={handleLogout} className="rounded-xl px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/5">Sair</button>}
            </nav>
          )}
        </header>

        {realtimeNotice && (
          <div className="mx-auto mt-4 max-w-7xl px-4 sm:px-6 lg:px-8" role="status" aria-live="polite">
            <p className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-100">
              {realtimeNotice}
            </p>
          </div>
        )}

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <Outlet />
        </main>
        <footer className="jungle-footer mt-12">
          <div className="mx-auto grid max-w-7xl gap-5 px-4 py-8 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8">
            <section className="border border-white/10 bg-slate-900/60 p-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 font-bold text-slate-950">W</span>
              <h2 className="mt-4 text-sm font-semibold text-white">Segurança da carteira</h2>
              <p className="mt-2 text-xs leading-5 text-slate-400">Proteja suas coleções com conexão segura e transações verificadas.</p>
            </section>
            <section className="border border-white/10 bg-slate-900/60 p-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 font-bold text-slate-950">C</span>
              <h2 className="mt-4 text-sm font-semibold text-white">Criadores em destaque</h2>
              <p className="mt-2 text-xs leading-5 text-slate-400">Conheça artistas independentes e acompanhe novas coleções.</p>
            </section>
            <section className="border border-white/10 bg-slate-900/60 p-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 font-bold text-slate-950">D</span>
              <h2 className="mt-4 text-sm font-semibold text-white">Alertas de lançamentos</h2>
              <p className="mt-2 text-xs leading-5 text-slate-400">Fique por dentro das novidades e dos próximos drops.</p>
            </section>
            <section className="border border-white/10 bg-slate-900/60 p-4">
              <h2 className="text-sm font-semibold text-white">Antecipe seu próximo lançamento</h2>
              <p className="mt-2 text-xs leading-5 text-slate-400">Crie sua conta e acompanhe novidades do universo Kurio.</p>
              <Link to="/signup" className="mt-4 inline-flex bg-violet-600 px-4 py-2 text-xs font-semibold text-slate-950">Criar conta</Link>
            </section>
          </div>
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8">
            <div>
              <Link to="/" className="text-lg font-semibold tracking-[0.16em] text-white">KURIO</Link>
              <p className="mt-3 max-w-xs text-sm text-slate-400">
                Feito para colecionadores, criadores e cultura digital.
              </p>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Minha conta</h2>
              <div className="mt-3 flex flex-col gap-2 text-sm text-slate-400">
                <Link to="/profile" className="hover:text-white">Meu perfil</Link>
                <Link to="/wallets" className="hover:text-white">Carteiras</Link>
                <Link to="/cart" className="hover:text-white">Carrinho</Link>
              </div>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Explorar</h2>
              <div className="mt-3 flex flex-col gap-2 text-sm text-slate-400">
                <Link to="/" className="hover:text-white">Coleções</Link>
                <Link to="/" className="hover:text-white">Arte digital</Link>
                <Link to="/" className="hover:text-white">Utilidades</Link>
              </div>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Carteiras compatíveis</h2>
              <p className="mt-3 text-sm text-slate-400">MetaMask · WalletConnect · Coinbase</p>
              <p className="mt-6 text-xs text-slate-500">© 2026 Kurio. Propriedade digital para todos.</p>
            </div>
          </div>
        </footer>
      </div>
      )
    },
  })

  const catalogRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: function CatalogRoute() {
      const { user, favorites, toggleFavorite, cart, addToCart } = useMarketplace()
      return <CatalogPage user={user} favorites={favorites} toggleFavorite={toggleFavorite} cart={cart} addToCart={addToCart} />
    },
  })

  const nftDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/nft/$id',
    component: function NftDetailRoute() {
      const { user, favorites, toggleFavorite, addToCart } = useMarketplace()
      return <NftDetailPage user={user} favorites={favorites} toggleFavorite={toggleFavorite} addToCart={addToCart} />
    },
  })

  const cartRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/cart',
    beforeLoad: async ({ location }) => {
      const { data } = await api.get<{ user: User | null }>('/session')
      queryClient.setQueryData(['session'], data)
      if (!data.user) throw redirect({ to: '/login', search: { redirect: location.href } })
    },
    component: function CartRoute() {
      const { user, cart, updateCartQty, removeFromCart, addToCart } = useMarketplace()
      return user ? (
        <CartPage cart={cart} updateCartQty={updateCartQty} removeFromCart={removeFromCart} addToCart={addToCart} />
      ) : (
        <p role="status">Loading your account…</p>
      )
    },
  })

  const checkoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/checkout',
    beforeLoad: async ({ location }) => {
      const { data } = await api.get<{ user: User | null }>('/session')
      queryClient.setQueryData(['session'], data)
      if (!data.user) throw redirect({ to: '/login', search: { redirect: location.href } })
    },
    component: function CheckoutRoute() {
      const { user, wallets, cart, nftRevision, handleOrder } = useMarketplace()
      return user ? (
        <CheckoutPage
          user={user}
          wallets={wallets}
          cart={cart}
          nftRevision={nftRevision}
          handleOrder={handleOrder}
          onSessionExpired={handleSessionExpired}
        />
      ) : (
        <p role="status">Loading your account…</p>
      )
    },
  })

  const confirmationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/confirmation/$orderId',
    beforeLoad: async ({ location }) => {
      const { data } = await api.get<{ user: User | null }>('/session')
      queryClient.setQueryData(['session'], data)
      if (!data.user) throw redirect({ to: '/login', search: { redirect: location.href } })
    },
    component: function ConfirmationRoute() {
      const { orders, user } = useMarketplace()
      return <ConfirmationPage orders={orders} userId={user?.id ?? ''} />
    },
  })

  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: function LoginRoute() {
      const { handleLogin, user } = useMarketplace()
      return <LoginPage onLogin={handleLogin} user={user} />
    },
  })

  const signupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/signup',
    component: function SignupRoute() {
      const { handleSignup, user } = useMarketplace()
      return <SignupPage onSignup={handleSignup} user={user} />
    },
  })

  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profile',
    beforeLoad: async ({ location }) => {
      const { data } = await api.get<{ user: User | null }>('/session')
      queryClient.setQueryData(['session'], data)
      if (!data.user) throw redirect({ to: '/login', search: { redirect: location.href } })
    },
    component: function ProfileRoute() {
      const { user, updateProfile, updatePassword, handleLogout } = useMarketplace()
      return user
        ? <ProfilePage user={user} updateProfile={updateProfile} updatePassword={updatePassword} handleLogout={handleLogout} />
        : <p role="status">Loading your account…</p>
    },
  })

  const walletsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/wallets',
    beforeLoad: async ({ location }) => {
      const { data } = await api.get<{ user: User | null }>('/session')
      queryClient.setQueryData(['session'], data)
      if (!data.user) throw redirect({ to: '/login', search: { redirect: location.href } })
    },
    component: function WalletsRoute() {
      const { user, wallets, saveWallet, removeWallet, setPrimaryWallet } = useMarketplace()
      return user
        ? <WalletsPage wallets={wallets} saveWallet={saveWallet} removeWallet={removeWallet} setPrimaryWallet={setPrimaryWallet} />
        : <p role="status">Loading your account…</p>
    },
  })

  const routeTree = rootRoute.addChildren([
    catalogRoute,
    nftDetailRoute,
    cartRoute,
    checkoutRoute,
    confirmationRoute,
    loginRoute,
    signupRoute,
    profileRoute,
    walletsRoute,
  ])

  const [router] = useState(() => createRouter({ routeTree }))

  const contextValue: MarketplaceContextValue = {
    user,
    favorites,
    cart,
    setCart,
    wallets,
    orders,
    realtimeNotice,
    mobileNavOpen,
    setMobileNavOpen,
    nftRevision,
    addToCart,
    updateCartQty,
    removeFromCart,
    toggleFavorite,
    handleLogin,
    handleSignup,
    updateProfile,
    updatePassword,
    saveWallet,
    removeWallet,
    setPrimaryWallet,
    handleOrder,
    handleLogout,
  }

  return (
    <MarketplaceContext.Provider value={contextValue}>
      <RouterProvider router={router} />
    </MarketplaceContext.Provider>
  )
}

function NftArtwork({
  src,
  alt,
  variant,
  className = '',
  loading = 'lazy',
  fetchPriority,
}: {
  src: string
  alt: string
  variant: string
  className?: string
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
}) {
  return (
    <div className={`nft-artwork ${className}`} data-artwork-variant={variant}>
      <span className="nft-artwork__orbit" aria-hidden="true" />
      <img src={src} alt={alt} loading={loading} fetchPriority={fetchPriority} decoding="async" />
      <span className="nft-artwork__spark nft-artwork__spark--one" aria-hidden="true" />
      <span className="nft-artwork__spark nft-artwork__spark--two" aria-hidden="true" />
    </div>
  )
}

function artworkVariant(nftId: string) {
  const numericId = Number(nftId.replace(/\D/g, ''))
  return Number.isFinite(numericId) ? String((numericId - 1) % 4) : '0'
}

function CatalogPage({
  user,
  favorites,
  toggleFavorite,
  cart,
  addToCart,
}: {
  user: User | null
  favorites: string[]
  toggleFavorite: (nftId: string) => void
  cart: CartItem[]
  addToCart: (nftId: string, quantity: number) => Promise<void>
}) {
  const navigate = useNavigate()
  const routerState = useRouterState()
  const search = getSearchParam(routerState.location.href, 'search')
  const category = getSearchParam(routerState.location.href, 'category', 'all')
  const sort = getSearchParam(routerState.location.href, 'sort', 'featured')
  const parsedPage = Number(getSearchParam(routerState.location.href, 'page', '1'))
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1
  const pageSize = 6

  const updateQuery = (updates: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(window.location.search)
    Object.entries(updates).forEach(([key, value]) => {
      if (!value) {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    })

    if (resetPage) {
      next.set('page', '1')
    }

    void navigate({ to: '/', search: Object.fromEntries(next.entries()) })
  }

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['nfts', search, category, sort, page],
    queryFn: async () => {
      const response = await api.get('/nfts', { params: { search, category, sort, page, limit: pageSize } })
      return response.data as { items: NFT[]; total: number }
    },
  })

  const items = data?.items ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  const safePage = Math.min(page, totalPages)

  return (
    <>
      <section className="jungle-hero relative overflow-hidden rounded-[32px] border border-white/10 p-6 md:p-10">
        <div className="relative grid gap-8 md:grid-cols-[1.15fr_0.85fr] md:items-center">
          <div>
            <p className="mb-3 inline-flex rounded-sm border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-violet-200">
              Arte digital exclusiva
            </p>
            <h1 className="max-w-xl text-4xl font-black tracking-tight text-white md:text-6xl">
              Seja dono do futuro da arte digital.
            </h1>
            <p className="mt-4 max-w-lg text-base text-slate-300 md:text-lg">
              Descubra coleções únicas, apoie artistas e encontre sua próxima peça digital.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/cart" className="rounded-sm bg-violet-600 px-5 py-3 font-medium text-slate-900">
                Explorar mercado
              </Link>
              <Link to="/profile" className="rounded-sm border border-white/20 bg-white/5 px-5 py-3 font-medium text-white">
                Conhecer criadores
              </Link>
            </div>
          </div>

          <div className="rounded-[28px] border border-violet-400/20 bg-slate-950/50 p-4">
            <NftArtwork
              src="/nfts/ape-sailor.svg"
              alt="Ilustração de macaco colecionável em estilo cartoon"
              variant="0"
              className="h-72 w-full rounded-sm"
              loading="eager"
              fetchPriority="high"
            />
            <div className="mt-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Lançamento em destaque</p>
                <h2 className="mt-1 text-xl font-semibold text-white">Neon Pulse</h2>
              </div>
              <div className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-sm font-medium text-emerald-300">
                1.24 ETH
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="marketplace" className="mt-8 rounded-[28px] border border-white/10 bg-slate-900/80 p-4 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              aria-label="Search by collection or artist"
              value={search}
              onChange={(event) => updateQuery({ search: event.target.value.trimStart() || null })}
              placeholder="Search by collection or artist"
              className="w-full bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {['all', 'Art', 'Gaming', 'Music', 'Photography', 'Utility'].map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => updateQuery({ category: option === 'all' ? null : option })}
                className={`rounded-full px-3 py-2 text-sm ${category === option ? 'bg-violet-600 text-white' : 'border border-white/10 bg-white/5 text-slate-300'}`}
              >
                {option}
              </button>
            ))}
          </div>

          <select
            aria-label="Sort NFTs"
            value={sort}
            onChange={(event) => updateQuery({ sort: event.target.value })}
            className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white focus:outline-none"
          >
            <option value="featured">Featured</option>
            <option value="trending">Trending</option>
            <option value="price-low">Price: low to high</option>
            <option value="price-high">Price: high to low</option>
          </select>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Mercado</p>
            <h2 className="mt-2 text-2xl font-bold text-white">NFTs em destaque</h2>
          </div>
          {user && <span className="text-sm text-slate-400">Welcome back, {user.name.split(' ')[0]}</span>}
        </div>

        {isLoading && <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading catalog" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton-shimmer h-[420px] rounded-[28px] border border-white/10" />)}</div>}
        {isError && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-10 text-center text-red-200" role="alert">
            <p>Unable to load NFTs.</p>
            <button type="button" onClick={() => void refetch()} className="mt-4 rounded-full border border-red-200/30 px-4 py-2 text-sm text-white">Try again</button>
          </div>
        )}

        {!isLoading && !isError && (
          <>
            {items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/60 p-12 text-center text-slate-300">
                No NFTs match your current filters.
              </div>
            ) : (
              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {items.map((nft) => {
                  const inCart = cart.find((item) => item.nftId === nft.id)?.quantity ?? 0
                  const isFavorite = favorites.includes(nft.id)
                  return (
                    <article key={nft.id} className="overflow-hidden rounded-[28px] border border-white/10 bg-slate-900/80 shadow-lg shadow-slate-950/30">
                      <div className="relative">
                        <NftArtwork src={nft.image} alt={nft.name} variant={artworkVariant(nft.id)} className="h-72 w-full" />
                        <button
                          type="button"
                          aria-label={`${isFavorite ? 'Remove' : 'Add'} ${nft.name} ${isFavorite ? 'from' : 'to'} favorites`}
                          aria-pressed={isFavorite}
                          onClick={() => toggleFavorite(nft.id)}
                          className="absolute right-4 top-4 rounded-full border border-white/20 bg-slate-950/60 p-2 text-white"
                        >
                          <Heart className={`h-4 w-4 ${isFavorite ? 'fill-pink-500 text-pink-500' : ''}`} />
                        </button>
                      </div>
                      <div className="p-5">
                        <div className="mb-3 flex items-center justify-between">
                          <span className="rounded-full border border-violet-400/20 bg-violet-500/10 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-violet-200">
                            {nft.collection}
                          </span>
                          <span className="flex items-center gap-1 text-sm text-slate-300">
                            <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                            {nft.likes}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-xl font-semibold text-white">{nft.name}</h3>
                            <p className="text-sm text-slate-400">by {nft.artist}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-2xl font-bold text-violet-300">{formatEth(nft.price)}</p>
                            <p className="text-xs text-slate-400">{nft.available} available</p>
                          </div>
                        </div>
                        <div className="mt-5 flex items-center gap-3">
                          <Link to={`/nft/${nft.id}`} className="flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-3 text-center text-sm font-medium text-white">
                            View details
                          </Link>
                          <button
                            type="button"
                            onClick={() => addToCart(nft.id, 1)}
                            className="rounded-full bg-violet-600 px-4 py-3 text-sm font-medium text-white"
                          >
                            {inCart > 0 ? `Add (+${inCart})` : 'Buy now'}
                          </button>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}

            <div className="mt-8 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => {
                  updateQuery({ page: String(Math.max(1, safePage - 1)) }, false)
                }}
                disabled={safePage <= 1}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-sm text-slate-300">
                Page {safePage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => {
                  updateQuery({ page: String(Math.min(totalPages, safePage + 1)) }, false)
                }}
                disabled={safePage >= totalPages}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
    </>
  )
}

function NftDetailPage({
  user,
  favorites,
  toggleFavorite,
  addToCart,
}: {
  user: User | null
  favorites: string[]
  toggleFavorite: (nftId: string) => void
  addToCart: (nftId: string, quantity: number) => Promise<void>
}) {
  const navigate = useNavigate()
  const { id } = useParams({ strict: false })
  const [quantity, setQuantity] = useState(1)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['nft', id],
    queryFn: async () => {
      const response = await api.get(`/nfts/${id}`)
      return response.data.nft as NFT
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading NFT details" aria-busy="true">
        <div className="skeleton-shimmer h-5 w-36 rounded" />
        <div className="overflow-hidden rounded-[32px] border border-white/10 bg-slate-900/80">
          <div className="skeleton-shimmer h-72 md:h-96" />
          <div className="grid gap-8 p-5 md:grid-cols-[1.4fr_0.6fr] md:p-8">
            <div>
              <div className="mb-4 flex items-center justify-between">
                <div className="skeleton-shimmer h-6 w-28 rounded-full" />
                <div className="skeleton-shimmer h-10 w-24 rounded-full" />
              </div>
              <div className="skeleton-shimmer h-10 w-2/3 rounded-xl" />
              <div className="skeleton-shimmer mt-3 h-4 w-1/3 rounded" />
              <div className="skeleton-shimmer mt-6 h-20 max-w-xl rounded-xl" />
              <div className="mt-8 grid gap-4 sm:grid-cols-3">
                <div className="skeleton-shimmer h-20 rounded-2xl" />
                <div className="skeleton-shimmer h-20 rounded-2xl" />
                <div className="skeleton-shimmer h-20 rounded-2xl" />
              </div>
            </div>
            <aside className="min-h-[430px] rounded-[28px] border border-white/10 bg-slate-950/70 p-5">
              <div className="skeleton-shimmer h-4 w-32 rounded" />
              <div className="skeleton-shimmer mt-3 h-12 w-2/3 rounded-xl" />
              <div className="skeleton-shimmer mt-6 h-14 rounded-2xl" />
              <div className="mt-6 space-y-3">
                <div className="skeleton-shimmer h-5 rounded" />
                <div className="skeleton-shimmer h-5 rounded" />
              </div>
              <div className="skeleton-shimmer mt-6 h-12 rounded-full" />
              {!user && <div className="skeleton-shimmer mt-3 h-11 rounded-full" />}
            </aside>
          </div>
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-10 text-center text-red-200">This NFT is unavailable.</div>
  }

  const isFavorite = favorites.includes(data.id)
  const total = multiplyEth(data.price, quantity)

  return (
    <div className="space-y-6">
      <button type="button" onClick={() => navigate({ to: '/' })} className="inline-flex items-center gap-2 text-sm text-slate-300">
        <ArrowLeft className="h-4 w-4" />
        Voltar ao mercado
      </button>

      <div className="overflow-hidden rounded-[32px] border border-white/10 bg-slate-900/80">
        <div className="grid gap-8 p-5 md:grid-cols-[1.05fr_0.95fr] md:p-8">
          <div>
            <NftArtwork src={data.banner} alt={data.name} variant={artworkVariant(data.id)} className="mb-6 aspect-square w-full md:max-h-[520px]" />
            <div className="mb-4 flex items-center justify-between">
              <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-violet-200">
                {data.collection}
              </span>
              <button type="button" aria-label={isFavorite ? 'Remove from favorites' : 'Save to favorites'} aria-pressed={isFavorite} onClick={() => toggleFavorite(data.id)} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200">
                <Heart className={`h-4 w-4 ${isFavorite ? 'fill-pink-500 text-pink-500' : ''}`} />
                {isFavorite ? 'Salvo' : 'Salvar'}
              </button>
            </div>
            <h1 className="text-4xl font-black text-white">{data.name}</h1>
            <p className="mt-3 text-sm uppercase tracking-[0.2em] text-slate-400">por {data.artist}</p>
            <p className="mt-6 max-w-xl text-base text-slate-300">{data.description}</p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              <StatCard label="Edição" value={data.edition} />
              <StatCard label="Disponíveis" value={`${data.available}`} />
              <StatCard label="Curtidas" value={String(data.likes)} />
            </div>
          </div>

          <aside className="rounded-[28px] border border-white/10 bg-slate-950/70 p-5">
            <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Preço atual</p>
            <div className="mt-3 flex items-end gap-2">
              <span className="text-4xl font-black text-white">{formatEth(data.price)}</span>
              <span className="text-sm text-slate-400">≈ ${(Number(data.price) * 4300).toFixed(2)}</span>
            </div>

            <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between text-sm text-slate-300">
                <span>Quantidade</span>
                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-900 px-2 py-1">
                  <button type="button" aria-label="Decrease quantity" onClick={() => setQuantity((value) => Math.max(1, value - 1))} className="p-1">
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="min-w-4 text-center font-medium text-white">{quantity}</span>
                  <button type="button" aria-label="Increase quantity" onClick={() => setQuantity((value) => Math.min(data.available, value + 1))} className="p-1">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 space-y-3 text-sm text-slate-300">
              <div className="flex items-center justify-between">
                <span>Subtotal</span>
                <span>{formatEth(total)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Taxa de rede</span>
                <span>0.04 ETH</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                void addToCart(data.id, quantity)
                navigate({ to: '/cart' })
              }}
              className="mt-6 w-full rounded-full bg-violet-600 px-4 py-3 font-medium text-white"
            >
              Adicionar ao carrinho
            </button>
            {!user && (
              <Link to="/login" className="mt-3 block w-full rounded-full border border-white/10 bg-white/5 px-4 py-3 text-center text-sm font-medium text-white">
                Entrar para comprar
              </Link>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

function CartPage({
  cart,
  updateCartQty,
  removeFromCart,
  addToCart,
}: {
  cart: CartItem[]
  updateCartQty: (nftId: string, quantity: number) => Promise<void>
  removeFromCart: (nftId: string) => Promise<void>
  addToCart: (nftId: string, quantity: number) => Promise<void>
}) {
  const navigate = useNavigate()
  const { data: nfts = [], isLoading: isLoadingNfts, isError: isNftError } = useQuery({
    queryKey: ['nfts-all'],
    queryFn: async () => {
      const response = await api.get('/nfts', { params: { category: 'all', sort: 'featured' } })
      return response.data.items as NFT[]
    },
  })

  const [couponState, setCouponState] = useState<{ valid: boolean; discount: number; label: string } | null>(
    () => readStorage('jungle-coupon', null),
  )
  const [coupon, setCoupon] = useState(() => couponState?.label ?? '')
  const quoteQuery = useQuery({
    queryKey: ['cart-quote', cart, couponState?.valid ? couponState.label : null],
    queryFn: async () => {
      const response = await api.post<Quote>('/quote', {
        items: cart,
        couponCode: couponState?.valid ? couponState.label : undefined,
      })
      return response.data
    },
    enabled: cart.length > 0,
  })

  const nftMap = new Map((nfts as NFT[]).map((nft) => [nft.id, nft]))
  const items = cart
    .map((entry) => ({ ...entry, nft: nftMap.get(entry.nftId) }))
    .filter((item) => item.nft)
  const recommendations = (nfts as NFT[])
    .filter((nft) => !cart.some((entry) => entry.nftId === nft.id))
    .slice(0, 5)

  const subtotal = quoteQuery.data?.subtotal ?? '0'
  const networkFee = quoteQuery.data?.networkFee ?? '0.04'
  const couponDiscount = quoteQuery.data?.discount ?? '0'
  const total = quoteQuery.data?.total ?? '0'

  useEffect(() => {
    if (couponState?.valid) localStorage.setItem('jungle-coupon', JSON.stringify(couponState))
    else localStorage.removeItem('jungle-coupon')
  }, [couponState])

  const applyCoupon = async () => {
    const cleaned = coupon.trim().toUpperCase()
    if (!cleaned) {
      setCouponState({ valid: false, discount: 0, label: '' })
      return
    }

    try {
      const response = await api.post('/coupons/validate', { code: cleaned })
      const next = {
        valid: Boolean(response.data.valid),
        discount: Number(response.data.discount ?? 0),
        label: String(response.data.label ?? cleaned),
      }
      setCouponState(next)
    } catch {
      setCouponState({ valid: false, discount: 0, label: cleaned })
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-[30px] border border-white/10 bg-slate-900/70 p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Carrinho</p>
            <h1 aria-label="Your selected pieces" className="mt-2 text-3xl font-bold text-white">Peças selecionadas</h1>
          </div>
          <button type="button" onClick={() => { void Promise.all(cart.map((item) => removeFromCart(item.nftId))); setCouponState(null) }} className="text-sm text-slate-300">Limpar tudo</button>
        </div>

        <div data-testid="cart-items" className="mt-6 space-y-4">
          {isLoadingNfts && <div className="space-y-4" role="status" aria-label="Loading cart summary" aria-busy="true">
            <div className="skeleton-shimmer h-32 rounded-[24px] border border-white/10" />
            <div className="skeleton-shimmer h-28 rounded-2xl border border-white/10" />
          </div>}
          {isNftError && <p role="alert" className="text-sm text-red-200">Unable to load current NFT prices. Refresh to try again.</p>}
          {quoteQuery.isError && <p role="alert" className="text-sm text-red-200">{getApiErrorMessage(quoteQuery.error, 'Unable to calculate the current cart quote.')}</p>}
          {items.length === 0 && !isLoadingNfts && !isNftError && (
            <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-10 text-center text-slate-300">
              Seu carrinho está vazio. Explore a coleção e encontre uma peça especial.
            </div>
          )}

          {items.map((item) => (
            <div key={item.nftId} className="flex flex-col gap-4 rounded-[24px] border border-white/10 bg-slate-950/50 p-4 sm:flex-row sm:items-center">
              <NftArtwork src={item.nft!.image} alt={item.nft!.name} variant={artworkVariant(item.nft!.id)} className="h-24 w-24 shrink-0 rounded-2xl" />
              <div className="flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">{item.nft!.name}</h3>
                    <p className="text-sm text-slate-400">{item.nft!.collection}</p>
                  </div>
                  <button type="button" onClick={() => void removeFromCart(item.nftId)} className="rounded-full border border-white/10 bg-white/5 p-2 text-slate-300">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-900 px-2 py-1">
                    <button type="button" aria-label={`Decrease ${item.nft!.name} quantity`} onClick={() => void updateCartQty(item.nftId, item.quantity - 1)} className="p-1">
                      <Minus className="h-4 w-4" />
                    </button>
                    <span aria-label={`Quantity ${item.quantity}`} className="min-w-5 text-center text-sm text-white">{item.quantity}</span>
                    <button type="button" aria-label={`Increase ${item.nft!.name} quantity`} onClick={() => void updateCartQty(item.nftId, item.quantity + 1)} className="p-1">
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  <span className="text-lg font-semibold text-violet-300">{formatEth(quoteQuery.data?.items.find((quoted) => quoted.nftId === item.nftId)?.price ? multiplyEth(quoteQuery.data.items.find((quoted) => quoted.nftId === item.nftId)!.price, item.quantity) : multiplyEth(item.nft!.price, item.quantity))}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <aside className="rounded-[30px] border border-white/10 bg-slate-900/70 p-5">
        <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Resumo do carrinho</p>
        <div className="mt-5 space-y-3 text-sm text-slate-300">
          <div className="flex justify-between"><span>Subtotal</span><span>{formatEth(subtotal)}</span></div>
          <div className="flex justify-between"><span>Network fee</span><span>{formatEth(networkFee)}</span></div>
          <div className="flex justify-between"><span>Discount</span><span>-{formatEth(couponDiscount)}</span></div>
        </div>

        <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/60 p-3">
          <label htmlFor="cart-coupon" className="text-xs uppercase tracking-[0.2em] text-slate-400">Cupom</label>
          <div className="mt-3 flex gap-2">
            <input id="cart-coupon" aria-label="Coupon code" value={coupon} onChange={(event) => setCoupon(event.target.value)} placeholder="BEMVINDO10" className="w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none" />
            <button type="button" onClick={() => void applyCoupon()} className="rounded-xl bg-violet-600 px-3 py-2 text-sm text-white">Aplicar</button>
          </div>
          {couponState && (
            <div className={`mt-3 flex items-center justify-between gap-2 text-xs ${couponState.valid ? 'text-emerald-300' : 'text-red-300'}`}>
              <span>{couponState.valid ? `Coupon ${couponState.label} applied` : 'Coupon invalid or expired'}</span>
              {couponState.valid && (
                <button type="button" onClick={() => setCouponState(null)} className="text-violet-300 underline">Remove</button>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-white/10 pt-4 text-lg font-semibold text-white">
          <div className="flex items-center justify-between">
            <span>Total</span>
            <span>{formatEth(total)}</span>
          </div>
        </div>

        <button type="button" aria-label="Proceed to checkout" disabled={cart.length > 0 && (quoteQuery.isLoading || quoteQuery.isError)} onClick={() => navigate({ to: '/checkout' })} className="mt-6 w-full rounded-full bg-violet-600 px-4 py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
          Ir para pagamento
        </button>
      </aside>
      <section className="lg:col-span-2">
        <div className="mb-5">
          <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Para sua coleção</p>
          <h2 className="mt-2 text-2xl font-bold text-white">Colecionadores também viram</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {recommendations.map((nft) => (
            <article key={nft.id} className="overflow-hidden border border-white/10 bg-slate-900/80">
              <NftArtwork src={nft.image} alt={nft.name} variant={artworkVariant(nft.id)} className="aspect-square w-full" />
              <div className="p-3">
                <h3 className="truncate text-sm font-semibold text-white">{nft.name}</h3>
                <p className="mt-1 text-xs text-violet-300">{formatEth(nft.price)}</p>
                <button type="button" onClick={() => void addToCart(nft.id, 1)} className="mt-3 w-full bg-violet-600 px-3 py-2 text-xs font-medium text-white">
                  Adicionar
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function CheckoutPage({
  user,
  wallets,
  cart,
  nftRevision,
  handleOrder,
  onSessionExpired,
}: {
  user: User | null
  wallets: WalletType[]
  cart: CartItem[]
  nftRevision: number
  handleOrder: (items: Array<{ nftId: string; quantity: number; price: string }>, total: string, couponCode: string | undefined, idempotencyKey: string) => Promise<Order>
  onSessionExpired: () => Promise<void>
}) {
  const navigate = useNavigate()
  const { data: nfts = [] } = useQuery({
    queryKey: ['nfts-all-2'],
    queryFn: async () => {
      const response = await api.get('/nfts', { params: { category: 'all', sort: 'featured' } })
      return response.data.items as NFT[]
    },
  })

  const nftMap = new Map((nfts as NFT[]).map((nft) => [nft.id, nft]))
  const items = cart
    .map((entry) => ({ ...entry, nft: nftMap.get(entry.nftId) }))
    .filter((item) => item.nft)

  const coupon = readStorage<{ valid: boolean; discount: number; label: string } | null>('jungle-coupon', null)
  const quoteQuery = useQuery({
    queryKey: ['checkout-quote', cart, coupon?.valid ? coupon.label : null, nftRevision],
    queryFn: async () => {
      const response = await api.post<Quote>('/quote', {
        items: cart,
        couponCode: coupon?.valid ? coupon.label : undefined,
      })
      return response.data
    },
    enabled: cart.length > 0,
  })
  const subtotal = quoteQuery.data?.subtotal ?? '0'
  const discount = quoteQuery.data?.discount ?? '0'
  const networkFee = quoteQuery.data?.networkFee ?? '0.04'
  const total = quoteQuery.data?.total ?? '0'
  const [selectedWalletId, setSelectedWalletId] = useState(wallets.find((wallet) => wallet.isPrimary)?.id ?? wallets[0]?.id ?? '')
  const [isConnected, setIsConnected] = useState(true)
  const [simulatedNetwork, setSimulatedNetwork] = useState('Ethereum')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [acceptedNftRevision, setAcceptedNftRevision] = useState(nftRevision)
  const [checkoutError, setCheckoutError] = useState('')
  const quoteIsStale = acceptedNftRevision !== nftRevision
  const unavailableItems = items.filter((item) => item.quantity > item.nft!.available)

  const handleCheckout = async () => {
    if (quoteIsStale) {
      setAcceptedNftRevision(nftRevision)
      setCheckoutError('')
      return
    }

    if (!user) {
      navigate({ to: '/login' })
      return
    }

    if (!isConnected || unavailableItems.length > 0 || items.length === 0 || quoteQuery.isError || quoteQuery.isLoading) {
      return
    }

    setIsSubmitting(true)
    setCheckoutError('')
    try {
      const previousQuote = quoteQuery.data
      const refreshedQuote = await quoteQuery.refetch()
      if (!refreshedQuote.data) throw new Error('Unable to retrieve a current checkout quote.')
      if (previousQuote && JSON.stringify(previousQuote) !== JSON.stringify(refreshedQuote.data)) {
        setAcceptedNftRevision(nftRevision - 1)
        setCheckoutError('The quote changed. Review the updated total before confirming.')
        return
      }
      const attemptFingerprint = JSON.stringify({
        userId: user.id,
        items: refreshedQuote.data.items,
        couponCode: refreshedQuote.data.couponCode,
        total: refreshedQuote.data.total,
      })
      const storedAttempt = sessionStorage.getItem('jungle-checkout-attempt')
      let idempotencyKey: string
      try {
        const parsed = storedAttempt ? JSON.parse(storedAttempt) as { fingerprint?: string; key?: string } : null
        idempotencyKey = parsed?.fingerprint === attemptFingerprint && parsed.key
          ? parsed.key
          : crypto.randomUUID()
      } catch {
        idempotencyKey = crypto.randomUUID()
      }
      sessionStorage.setItem('jungle-checkout-attempt', JSON.stringify({
        fingerprint: attemptFingerprint,
        key: idempotencyKey,
      }))
      const order = await handleOrder(
        refreshedQuote.data.items,
        refreshedQuote.data.total,
        refreshedQuote.data.couponCode ?? undefined,
        idempotencyKey,
      )
      if (order.status !== 'confirmed') {
        if (order.status === 'refused' || order.status === 'declined') {
          sessionStorage.removeItem('jungle-checkout-attempt')
        }
        setCheckoutError(`The order is ${order.status}. Your cart has been preserved.`)
        return
      }
      sessionStorage.removeItem('jungle-checkout-attempt')
      navigate({ to: `/confirmation/${order.id}` })
    } catch (error) {
      if (getApiErrorStatus(error) === 401) {
        await onSessionExpired()
        void navigate({ to: '/login', search: { redirect: '/checkout' } })
        return
      }
      setCheckoutError(getApiErrorMessage(error, 'Unable to complete this purchase. Please try again.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="rounded-[30px] border border-white/10 bg-slate-900/70 p-5">
        <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Pagamento</p>
        <h1 aria-label="Complete your purchase" className="mt-2 text-3xl font-bold text-white">Pagamento</h1>

        <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/50 p-4">
          <div className="flex items-center justify-between">
            <div>
            <p className="text-sm text-slate-400">Perfil do colecionador</p>
              <h2 className="mt-1 text-lg font-semibold text-white">{user?.name ?? 'Guest collector'}</h2>
            </div>
          <div className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">Verificado</div>
          </div>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-xs text-slate-400">
          Nome
          <input aria-label="Checkout name" readOnly value={user?.name ?? ''} className="mt-2 w-full border border-white/10 bg-slate-950 px-3 py-3 text-sm text-white" />
        </label>
        <label className="text-xs text-slate-400">
          E-mail
          <input aria-label="Checkout email" readOnly value={user?.email ?? ''} className="mt-2 w-full border border-white/10 bg-slate-950 px-3 py-3 text-sm text-white" />
        </label>
        </div>
        {quoteIsStale && (
          <p role="alert" className="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
            The price or availability changed while you were checking out. Review the updated quote before confirming.
          </p>
        )}
        {quoteQuery.isError && <p role="alert" className="mt-4 rounded-xl border border-red-300/25 bg-red-300/10 px-4 py-3 text-sm text-red-100">{getApiErrorMessage(quoteQuery.error, 'Unable to calculate a current quote.')}</p>}
        {unavailableItems.length > 0 && (
          <p role="alert" className="mt-4 rounded-xl border border-red-300/25 bg-red-300/10 px-4 py-3 text-sm text-red-100">
            One or more quantities exceed the current availability. Return to your cart to adjust them.
          </p>
        )}
        {checkoutError && <p role="alert" className="mt-4 text-sm text-red-200">{checkoutError}</p>}

        <div className="mt-6">
          <p className="mb-4 text-sm font-medium text-slate-300">Carteira e rede</p>
          <div className="space-y-3">
            {wallets.map((wallet) => (
              <button
                key={wallet.id}
                type="button"
                onClick={() => setSelectedWalletId(wallet.id)}
                className={`flex w-full items-center justify-between rounded-2xl border p-4 text-left ${selectedWalletId === wallet.id ? 'border-violet-500 bg-violet-500/10' : 'border-white/10 bg-slate-950/40'}`}
              >
                <div>
                  <div className="font-medium text-white">{wallet.label}</div>
                  <div className="text-sm text-slate-400">{wallet.address}</div>
                </div>
                <div className="text-xs uppercase tracking-[0.2em] text-violet-200">{wallet.network}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/50 p-4">
          <div className="flex items-center justify-between text-sm text-slate-300">
            <span>Conexão da carteira</span>
            <button type="button" onClick={() => setIsConnected((value) => !value)} className={`rounded-full px-3 py-1 ${isConnected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </button>
          </div>
          <div className="mt-4 space-y-3 text-sm text-slate-300">
            {['Ethereum', 'Polygon', 'Solana'].map((option) => (
              <label key={option} className="flex items-center gap-3">
                <input type="radio" name="network" checked={simulatedNetwork === option} onChange={() => setSimulatedNetwork(option)} />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <aside className="rounded-[30px] border border-white/10 bg-slate-900/70 p-5">
        <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Resumo do pedido</p>
        <div className="mt-5 space-y-3 text-sm text-slate-300">
          <div className="flex justify-between"><span>Subtotal</span><span>{formatEth(subtotal)}</span></div>
          <div className="flex justify-between"><span>Desconto</span><span>-{formatEth(discount)}</span></div>
          <div className="flex justify-between"><span>Taxa de rede</span><span>{formatEth(networkFee)}</span></div>
        </div>

        <div className="mt-6 space-y-3">
          {items.map((item) => (
            <div key={item.nftId} className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-950/40 p-3">
              <div>
                <div className="font-medium text-white">{item.nft!.name}</div>
                <div className="text-xs text-slate-400">Qtd. {item.quantity}</div>
              </div>
              <div className="text-violet-300">{formatEth(multiplyEth(item.nft!.price, item.quantity))}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 border-t border-white/10 pt-4 text-lg font-semibold text-white">
          <div className="flex items-center justify-between">
            <span>Total</span>
            <span>{formatEth(total)}</span>
          </div>
        </div>

        <button
          type="button"
          aria-label={isSubmitting ? 'Processing...' : quoteIsStale ? 'Review updated quote' : 'Confirm purchase'}
          disabled={isSubmitting || quoteQuery.isLoading || (!quoteIsStale && (!isConnected || unavailableItems.length > 0 || items.length === 0 || quoteQuery.isError))}
          onClick={() => void handleCheckout()}
          className="mt-6 w-full rounded-full bg-violet-600 px-4 py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? 'Processando...' : quoteIsStale ? 'Revisar cotação' : 'Confirmar compra'}
        </button>
      </aside>
    </div>
  )
}

function ConfirmationPage({ orders, userId }: { orders: Order[]; userId: string }) {
  const { orderId } = useParams({ strict: false })
  const orderQuery = useQuery({
    queryKey: ['order', userId, orderId],
    queryFn: async () => (await api.get<{ order: Order }>(`/orders/${orderId}`)).data.order,
    enabled: Boolean(userId && orderId),
  })
  const order = orderQuery.data ?? orders.find((entry) => entry.id === orderId)
  const navigate = useNavigate()

  if (orderQuery.isLoading) {
    return <div role="status" className="skeleton-shimmer mx-auto h-72 max-w-3xl rounded-[30px]" />
  }

  if (!order) {
    return <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-10 text-center text-red-200">No order found.</div>
  }

  if (order.status !== 'confirmed') {
    return (
      <div role="status" className="mx-auto max-w-3xl rounded-[30px] border border-amber-300/25 bg-slate-900/80 p-10 text-center">
        <h1 className="text-3xl font-bold text-white">Order {order.status}</h1>
        <p className="mt-3 text-slate-300">This receipt is available after the payment is confirmed.</p>
        <button type="button" onClick={() => navigate({ to: '/checkout' })} className="mt-6 rounded-full bg-violet-600 px-5 py-3 font-medium text-white">Return to checkout</button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl rounded-[30px] border border-emerald-400/25 bg-slate-900/80 p-6 text-center md:p-10">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
        <ShieldCheck className="h-10 w-10" />
      </div>
      <p className="mt-6 text-sm uppercase tracking-[0.2em] text-emerald-200">Pedido confirmado</p>
      <h1 aria-label="Your purchase is locked in." className="mt-3 text-4xl font-black text-white">Sua compra está confirmada.</h1>
      <p className="mt-3 text-slate-300">Transaction ID: {order.txHash}</p>

      <div className="mt-8 grid gap-4 rounded-2xl border border-white/10 bg-slate-950/50 p-5 text-left text-sm text-slate-300 sm:grid-cols-3">
        <div>
          <p className="text-slate-400">Order</p>
          <p className="mt-2 text-lg font-semibold text-white">#{order.id}</p>
        </div>
        <div>
          <p className="text-slate-400">Total</p>
          <p className="mt-2 text-lg font-semibold text-white">{formatEth(order.total)}</p>
        </div>
        <div>
          <p className="text-slate-400">Status</p>
          <p className="mt-2 text-lg font-semibold text-emerald-300">Confirmed</p>
        </div>
      </div>

      <button type="button" onClick={() => navigate({ to: '/' })} className="mt-8 rounded-full bg-violet-600 px-5 py-3 font-medium text-white">
        Continuar explorando
      </button>
    </div>
  )
}

function LoginPage({ onLogin, user }: { onLogin: (email: string, password: string) => Promise<User>; user: User | null }) {
  const router = useRouter()
  const [form, setForm] = useState({ email: 'maya@jungle.io', password: 'demo123' })
  const [error, setError] = useState('')
  const returnPath = getSafeReturnPath(router.state.location.href)

  useEffect(() => {
    if (user) router.history.replace(returnPath)
  }, [returnPath, router, user])

  if (user) return <p role="status">Returning to your checkout…</p>

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      await onLogin(form.email, form.password)
    } catch (err) {
      setError(getApiErrorMessage(err, 'Login failed'))
    }
  }

  return (
    <div className="auth-layout">
      <AuthShowcase />
      <section className="self-center p-6 md:p-10">
        <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Bem-vindo à Kurio</p>
        <h1 aria-label="Login" className="mt-2 text-3xl font-bold text-white">Entrar</h1>
        <p className="mt-2 text-sm text-slate-400">Acesse sua conta para continuar explorando.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block space-y-2 text-sm text-slate-300" htmlFor="login-email">E-mail
            <input id="login-email" aria-label="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} type="email" placeholder="seu@email.com" className="w-full border border-white/10 bg-slate-950 px-4 py-3 text-white focus:outline-none" />
          </label>
          <label className="block space-y-2 text-sm text-slate-300" htmlFor="login-password">Senha
            <input id="login-password" aria-label="Password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} type="password" placeholder="Sua senha" className="w-full border border-white/10 bg-slate-950 px-4 py-3 text-white focus:outline-none" />
          </label>
          {error && <div role="alert" className="text-sm text-red-300">{error}</div>}
          <button type="submit" aria-label="Login" className="w-full rounded-full bg-violet-600 px-4 py-3 font-medium text-white">Entrar</button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-400">
          Ainda não tem conta? <Link to="/signup" className="text-violet-300">Criar conta</Link>
        </p>
      </section>
    </div>
  )
}

function SignupPage({ onSignup, user }: { onSignup: (payload: { name: string; email: string; password: string }) => Promise<User>; user: User | null }) {
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: 'Ava Brooks', email: 'ava@jungle.io', password: 'pass123' })
  const [error, setError] = useState('')

  if (user) {
    return <Navigate to="/" replace />
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      await onSignup(form)
      navigate({ to: '/' })
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to create account'))
    }
  }

  return (
    <div className="auth-layout">
      <AuthShowcase />
      <section className="self-center p-6 md:p-10">
        <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Junte-se à Kurio</p>
        <h1 aria-label="Create account" className="mt-2 text-3xl font-bold text-white">Criar conta</h1>
        <p className="mt-2 text-sm text-slate-400">Comece sua coleção de arte digital.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block space-y-2 text-sm text-slate-300" htmlFor="signup-name">Nome completo
            <input id="signup-name" aria-label="Full name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} type="text" placeholder="Seu nome" className="w-full border border-white/10 bg-slate-950 px-4 py-3 text-white focus:outline-none" />
          </label>
          <label className="block space-y-2 text-sm text-slate-300" htmlFor="signup-email">E-mail
            <input id="signup-email" aria-label="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} type="email" placeholder="seu@email.com" className="w-full border border-white/10 bg-slate-950 px-4 py-3 text-white focus:outline-none" />
          </label>
          <label className="block space-y-2 text-sm text-slate-300" htmlFor="signup-password">Senha
            <input id="signup-password" aria-label="Password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} type="password" placeholder="Crie uma senha" className="w-full border border-white/10 bg-slate-950 px-4 py-3 text-white focus:outline-none" />
          </label>
          {error && <div role="alert" className="text-sm text-red-300">{error}</div>}
          <button type="submit" aria-label="Create account" className="w-full rounded-full bg-violet-600 px-4 py-3 font-medium text-white">Criar conta</button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-400">
          Já tem conta? <Link to="/login" className="text-violet-300">Entrar</Link>
        </p>
      </section>
    </div>
  )
}

function AuthShowcase() {
  const collections = [
    ['Arte digital', '33'],
    ['Fotografia', '12'],
    ['Música', '65'],
    ['Arte 3D', '39'],
    ['Colecionáveis', '23'],
    ['Generativa', '17'],
    ['Jogos', '19'],
    ['Utilidade', '18'],
  ]

  return (
    <aside className="auth-showcase">
      <div className="relative z-10">
        <p className="text-xs uppercase tracking-[0.22em] text-violet-200">Kurio · arte digital</p>
        <h2 className="mt-8 max-w-lg text-4xl font-black uppercase leading-tight text-white md:text-5xl">
          Seja dono do futuro da arte digital.
        </h2>
        <p className="mt-4 max-w-md text-sm leading-6 text-slate-300">
          Descubra NFTs selecionados de criadores independentes e encontre uma peça feita para sua coleção.
        </p>
        <Link to="/" className="mt-6 inline-flex rounded-sm bg-violet-600 px-5 py-3 text-sm font-semibold text-slate-950">
          Explorar
        </Link>
      </div>
      <div className="relative z-10 mt-10 border border-white/10 bg-slate-950/50 p-4">
        <h3 className="text-sm font-semibold text-white">Coleções</h3>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
          {collections.map(([name, count]) => (
            <Link key={name} to="/" className="flex justify-between gap-2 text-xs text-slate-400 hover:text-white">
              <span>{name}</span>
              <span>({count})</span>
            </Link>
          ))}
        </div>
      </div>
    </aside>
  )
}

function AccountSidebar({ active }: { active: 'profile' | 'wallets' }) {
  return (
    <nav aria-label="Account navigation" className="account-sidebar">
      <p className="mb-2 px-3 text-xs uppercase tracking-[0.18em] text-slate-400">Minha conta</p>
      <Link to="/profile" aria-current={active === 'profile' ? 'page' : undefined}>Meu perfil</Link>
      <Link to="/wallets" aria-current={active === 'wallets' ? 'page' : undefined}>Carteiras</Link>
      <Link to="/" hash="marketplace">Coleções</Link>
      <Link to="/cart">Carrinho</Link>
    </nav>
  )
}

function ProfilePage({
  user,
  updateProfile,
  updatePassword,
  handleLogout,
}: {
  user: User
  updateProfile: (payload: { name: string; email: string; avatar: string }) => Promise<User>
  updatePassword: (payload: { currentPassword: string; newPassword: string }) => Promise<void>
  handleLogout: () => void
}) {
  const [profile, setProfile] = useState({ name: user.name, email: user.email, avatar: user.avatar })
  const [password, setPassword] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [profileError, setProfileError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [notice, setNotice] = useState('')

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault()
    setProfileError('')
    setNotice('')
    try {
      const updated = await updateProfile(profile)
      setProfile({ name: updated.name, email: updated.email, avatar: updated.avatar })
      setNotice('Profile updated.')
    } catch (error: unknown) {
      setProfileError(getApiErrorMessage(error, 'Unable to update your profile.'))
    }
  }

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setPasswordError('')
    setNotice('')
    if (password.newPassword !== password.confirmPassword) {
      setPasswordError('New password and confirmation do not match.')
      return
    }
    try {
      await updatePassword({ currentPassword: password.currentPassword, newPassword: password.newPassword })
      setPassword({ currentPassword: '', newPassword: '', confirmPassword: '' })
      setNotice('Password updated.')
    } catch (error: unknown) {
      setPasswordError(getApiErrorMessage(error, 'Unable to update your password.'))
    }
  }

  return (
    <div className="account-page">
      <AccountSidebar active="profile" />
      <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
      <Card className="gap-5 rounded-[30px] border border-white/10 bg-slate-900/80 p-6 text-slate-100 ring-0">
        <CardHeader className="flex flex-row items-center gap-4 p-0">
          <img src={profile.avatar} alt={`${profile.name} avatar`} className="h-20 w-20 rounded-full object-cover" />
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Perfil do colecionador</p>
            <CardTitle className="mt-2 text-2xl font-bold text-white">{profile.name}</CardTitle>
          </div>
        </CardHeader>

        <form onSubmit={saveProfile} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-name" className="text-slate-400">Nome</Label>
            <Input id="profile-name" aria-label="Name" required minLength={2} value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-email" className="text-slate-400">E-mail</Label>
            <Input id="profile-email" aria-label="Email" required type="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-avatar" className="text-slate-400">URL da imagem do avatar (HTTPS)</Label>
            <Input id="profile-avatar" aria-label="Avatar image URL (HTTPS)" required type="url" value={profile.avatar} onChange={(event) => setProfile({ ...profile, avatar: event.target.value })} className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
          </div>
          {profileError && <p role="alert" className="text-sm text-red-300">{profileError}</p>}
          <Button type="submit" aria-label="Save profile" className="h-auto w-full rounded-full bg-violet-600 px-4 py-3 font-medium text-white hover:bg-violet-500">Salvar perfil</Button>
          <Button type="button" aria-label="Logout" variant="outline" onClick={handleLogout} className="h-auto w-full rounded-full border-white/10 bg-white/5 px-4 py-3 font-medium text-white hover:bg-white/10">Sair</Button>
        </form>
      </Card>

      <Card className="gap-5 rounded-[30px] border border-white/10 bg-slate-900/80 p-6 text-slate-100 ring-0">
        <CardHeader className="p-0">
          <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Segurança</p>
          <CardTitle aria-label="Update password" className="mt-2 text-2xl font-bold text-white">Atualizar senha</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 p-0">
          <form onSubmit={savePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password" className="text-slate-400">Senha atual</Label>
              <Input id="current-password" aria-label="Current password" required type="password" autoComplete="current-password" value={password.currentPassword} onChange={(event) => setPassword({ ...password, currentPassword: event.target.value })} className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password" className="text-slate-400">Nova senha</Label>
              <Input id="new-password" aria-label="New password" required minLength={8} type="password" autoComplete="new-password" value={password.newPassword} onChange={(event) => setPassword({ ...password, newPassword: event.target.value })} className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="text-slate-400">Confirmar nova senha</Label>
              <Input id="confirm-password" aria-label="Confirm new password" required minLength={8} type="password" autoComplete="new-password" value={password.confirmPassword} onChange={(event) => setPassword({ ...password, confirmPassword: event.target.value })} className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
            </div>
            {passwordError && <p role="alert" className="text-sm text-red-300">{passwordError}</p>}
            <Button type="submit" aria-label="Update password" variant="outline" className="h-auto w-full rounded-full border-white/10 bg-white/5 px-4 py-3 font-medium text-white hover:bg-white/10">Atualizar senha</Button>
          </form>
          {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
        </CardContent>
      </Card>
      </div>
    </div>
  )
}

function WalletsPage({
  wallets,
  saveWallet,
  removeWallet,
  setPrimaryWallet,
}: {
  wallets: WalletType[]
  saveWallet: (walletId: string | null, payload: Omit<WalletType, 'id' | 'isPrimary'>) => Promise<void>
  removeWallet: (walletId: string) => Promise<void>
  setPrimaryWallet: (walletId: string) => Promise<void>
}) {
  const emptyForm = { label: '', address: '', network: 'Ethereum' as WalletType['network'] }
  const [form, setForm] = useState(emptyForm)
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const submitWallet = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setNotice('')
    try {
      await saveWallet(editingWalletId, form)
      setNotice(editingWalletId ? 'Wallet updated.' : 'Wallet added.')
      setEditingWalletId(null)
      setForm(emptyForm)
    } catch (requestError: unknown) {
      setError(getApiErrorMessage(requestError, 'Unable to save this wallet.'))
    }
  }

  const editWallet = (wallet: WalletType) => {
    setEditingWalletId(wallet.id)
    setForm({ label: wallet.label, address: wallet.address, network: wallet.network })
    setError('')
    setNotice('')
  }

  const runWalletAction = async (action: () => Promise<void>, successMessage: string) => {
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(successMessage)
    } catch (requestError: unknown) {
      setError(getApiErrorMessage(requestError, 'Unable to update this wallet.'))
    }
  }

  return (
    <div className="account-page">
      <AccountSidebar active="wallets" />
      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <Card className="gap-5 rounded-[30px] border border-white/10 bg-slate-900/80 p-6 text-slate-100 ring-0">
        <CardHeader className="p-0">
          <p className="text-sm uppercase tracking-[0.2em] text-violet-200">Carteiras</p>
          <h1 aria-label="Connected accounts" className="mt-2 text-3xl font-bold text-white">Carteiras conectadas</h1>
        </CardHeader>
        <CardContent className="space-y-4 p-0">
          {wallets.map((wallet) => (
            <div key={wallet.id} className="flex flex-col gap-4 rounded-[24px] border border-white/10 bg-slate-950/40 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium text-white">
                  <span>{wallet.label}</span>
                  {wallet.isPrimary && <Badge className="bg-emerald-500/15 text-emerald-300">Principal</Badge>}
                </div>
                <div className="mt-1 break-all text-sm text-slate-400">{wallet.address}</div>
                <div className="mt-2 text-xs uppercase tracking-[0.2em] text-violet-200">{wallet.network}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => editWallet(wallet)} aria-label={`Edit ${wallet.label}`} className="h-auto rounded-full border-white/10 bg-white/5 px-3 py-2 text-xs text-white hover:bg-white/10">Editar</Button>
                {!wallet.isPrimary && <Button type="button" variant="outline" onClick={() => void runWalletAction(() => setPrimaryWallet(wallet.id), 'Primary wallet updated.')} aria-label={`Set ${wallet.label} as primary`} className="h-auto rounded-full border-white/10 bg-white/5 px-3 py-2 text-xs text-white hover:bg-white/10">Definir principal</Button>}
                <Button type="button" variant="destructive" onClick={() => void runWalletAction(() => removeWallet(wallet.id), 'Wallet removed.')} aria-label={`Remove ${wallet.label}`} className="h-auto rounded-full px-3 py-2 text-xs">Remover</Button>
              </div>
            </div>
          ))}
          {wallets.length === 0 && <p aria-label="No wallets saved yet." className="rounded-2xl border border-dashed border-white/10 p-6 text-sm text-slate-400">Nenhuma carteira salva.</p>}
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
        </CardContent>
      </Card>

      <Card className="gap-5 rounded-[30px] border border-white/10 bg-slate-900/80 p-6 text-slate-100 ring-0">
        <CardHeader className="p-0">
          <p className="text-sm uppercase tracking-[0.2em] text-violet-200">{editingWalletId ? 'Editar carteira' : 'Adicionar carteira'}</p>
          <CardTitle className="mt-2 text-2xl font-bold text-white">{editingWalletId ? 'Atualizar dados da carteira' : 'Conectar carteira'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <form onSubmit={submitWallet} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="wallet-label" className="text-slate-400">Nome da carteira</Label>
              <Input id="wallet-label" aria-label="Wallet label" required minLength={2} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="Nome" className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wallet-address" className="text-slate-400">Endereço da carteira</Label>
              <Input id="wallet-address" aria-label="Wallet address" required minLength={8} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="Endereço" className="h-auto rounded-2xl border-white/10 bg-slate-950 px-4 py-3 text-white" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wallet-network" className="text-slate-400">Rede</Label>
              <select id="wallet-network" aria-label="Network" value={form.network} onChange={(event) => setForm({ ...form, network: event.target.value as WalletType['network'] })} className="h-12 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300">
                <option>Ethereum</option>
                <option>Polygon</option>
                <option>Solana</option>
              </select>
            </div>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <Button type="submit" aria-label={editingWalletId ? 'Save wallet' : 'Add wallet'} className="h-auto w-full rounded-full bg-violet-600 px-4 py-3 font-medium text-white hover:bg-violet-500">{editingWalletId ? 'Salvar carteira' : 'Adicionar carteira'}</Button>
            {editingWalletId && <Button type="button" aria-label="Cancel edit" variant="outline" onClick={() => { setEditingWalletId(null); setForm(emptyForm); setError('') }} className="h-auto w-full rounded-full border-white/10 bg-white/5 px-4 py-3 text-white hover:bg-white/10">Cancelar edição</Button>}
          </form>
        </CardContent>
      </Card>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className="mt-2 text-lg font-semibold text-white">{value}</p>
    </div>
  )
}

export default App
