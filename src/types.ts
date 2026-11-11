export type NFT = {
  id: string
  name: string
  collection: string
  artist: string
  price: string
  image: string
  banner: string
  description: string
  category: 'Art' | 'Gaming' | 'Music' | 'Photography' | 'Utility'
  likes: number
  supply: number
  available: number
  edition: string
}

export type User = {
  id: string
  name: string
  email: string
  avatar: string
  wallet: string
}

export type CartItem = {
  nftId: string
  quantity: number
}

export type Wallet = {
  id: string
  label: string
  address: string
  network: 'Ethereum' | 'Polygon' | 'Solana'
  isPrimary: boolean
}

export type Order = {
  id: string
  status: 'pending' | 'confirmed' | 'refused' | 'declined'
  total: string
  currency: string
  items: Array<{ nftId: string; quantity: number; price: string }>
  txHash: string
  createdAt: string
}
