import { io } from 'socket.io-client'
import type { NFT, Order } from '../types'

export type RealtimeEvent<T> = {
  eventId: string
  resourceId: string
  version: number
  userId?: string
  data: T
}

export const createMarketplaceSocket = () =>
  io(window.location.origin, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
  })

export type NftUpdatedEvent = RealtimeEvent<NFT>
export type OrderUpdatedEvent = RealtimeEvent<Order>
