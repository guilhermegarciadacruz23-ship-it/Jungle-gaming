const ETH_DECIMALS = 18
const ETH_SCALE = 10n ** BigInt(ETH_DECIMALS)

const parseEthUnits = (value: string): bigint => {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) throw new Error(`Invalid ETH decimal: ${value}`)

  const fraction = match[3] ?? ''
  if (fraction.length > ETH_DECIMALS) throw new Error(`ETH supports at most ${ETH_DECIMALS} decimal places.`)

  const units = BigInt(match[2]) * ETH_SCALE + BigInt(fraction.padEnd(ETH_DECIMALS, '0') || '0')
  return match[1] ? -units : units
}

const formatEthUnits = (units: bigint): string => {
  const negative = units < 0n
  const absolute = negative ? -units : units
  const integer = absolute / ETH_SCALE
  const fraction = (absolute % ETH_SCALE).toString().padStart(ETH_DECIMALS, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`
}

export const addEth = (...values: string[]): string =>
  formatEthUnits(values.reduce((sum, value) => sum + parseEthUnits(value), 0n))

export const subtractEth = (left: string, right: string): string =>
  formatEthUnits(parseEthUnits(left) - parseEthUnits(right))

export const multiplyEth = (value: string, quantity: number): string => {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('ETH quantity must be a non-negative integer.')
  return formatEthUnits(parseEthUnits(value) * BigInt(quantity))
}

export const applyEthRate = (value: string, rate: number): string => {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('ETH discount rate must be between 0 and 1.')
  const rateBasisPoints = BigInt(Math.round(rate * 10_000))
  return formatEthUnits((parseEthUnits(value) * rateBasisPoints) / 10_000n)
}

export const compareEth = (left: string, right: string): number => {
  const leftUnits = parseEthUnits(left)
  const rightUnits = parseEthUnits(right)
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0
}

export const formatEth = (value: string): string => {
  const units = parseEthUnits(value)
  const negative = units < 0n
  const absolute = negative ? -units : units
  const thousandths = (absolute + 10n ** 14n / 2n) / 10n ** 15n
  const whole = thousandths / 1_000n
  const fraction = (thousandths % 1_000n).toString().padStart(3, '0')
  return `${negative ? '-' : ''}${whole}.${fraction} ETH`
}
