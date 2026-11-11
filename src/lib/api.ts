import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  timeout: 4000,
})

export const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

export { formatEth } from './eth'
