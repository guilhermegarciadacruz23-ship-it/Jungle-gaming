import { addEth, applyEthRate, multiplyEth } from './eth'
import type { CartItem, NFT } from '../types'

export type Quote = {
  items: Array<{ nftId: string; quantity: number; price: string }>
  subtotal: string
  discount: string
  networkFee: string
  total: string
  couponCode: string | null
}

export const calculateQuote = (nfts: NFT[], items: CartItem[], couponCode?: string): Quote => {
  const normalizedCode = couponCode?.trim().toUpperCase() || ''
  if (normalizedCode && normalizedCode !== 'WELCOME10') {
    throw new Error('Coupon expired or invalid.')
  }

  const quotedItems = items.map((item) => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error('Item quantities must be positive whole numbers.')
    }
    const nft = nfts.find((entry) => entry.id === item.nftId)
    if (!nft) throw new Error(`NFT ${item.nftId} is no longer available.`)
    if (item.quantity > nft.available) {
      throw new Error(`${nft.name} has only ${nft.available} available.`)
    }
    return { nftId: nft.id, quantity: item.quantity, price: nft.price }
  })

  const subtotal = quotedItems.reduce(
    (sum, item) => addEth(sum, multiplyEth(item.price, item.quantity)),
    '0',
  )
  const discount = normalizedCode ? applyEthRate(subtotal, 0.1) : '0'
  const networkFee = '0.04'
  const total = addEth(subtotal, networkFee, `-${discount}`)

  return {
    items: quotedItems,
    subtotal,
    discount,
    networkFee,
    total,
    couponCode: normalizedCode || null,
  }
}
