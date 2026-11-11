import { createContext, useContext } from 'react'
import type { CartItem, Order, User, Wallet } from '../types'

export type MarketplaceContextValue = {
  user: User | null
  favorites: string[]
  cart: CartItem[]
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>
  wallets: Wallet[]
  orders: Order[]
  realtimeNotice: string
  mobileNavOpen: boolean
  setMobileNavOpen: React.Dispatch<React.SetStateAction<boolean>>
  nftRevision: number
  addToCart: (nftId: string, quantity: number) => Promise<void>
  updateCartQty: (nftId: string, quantity: number) => Promise<void>
  removeFromCart: (nftId: string) => Promise<void>
  toggleFavorite: (nftId: string) => Promise<void>
  handleLogin: (email: string, password: string) => Promise<User>
  handleSignup: (payload: { name: string; email: string; password: string }) => Promise<User>
  updateProfile: (payload: { name: string; email: string; avatar: string }) => Promise<User>
  updatePassword: (payload: { currentPassword: string; newPassword: string }) => Promise<void>
  saveWallet: (walletId: string | null, payload: Omit<Wallet, 'id' | 'isPrimary'>) => Promise<void>
  removeWallet: (walletId: string) => Promise<void>
  setPrimaryWallet: (walletId: string) => Promise<void>
  handleOrder: (items: Array<{ nftId: string; quantity: number; price: string }>, total: string, couponCode: string | undefined, idempotencyKey: string) => Promise<Order>
  handleLogout: () => void
}

export const MarketplaceContext = createContext<MarketplaceContextValue | null>(null)

export const useMarketplace = () => {
  const context = useContext(MarketplaceContext)
  if (!context) throw new Error('Marketplace context is unavailable.')
  return context
}
