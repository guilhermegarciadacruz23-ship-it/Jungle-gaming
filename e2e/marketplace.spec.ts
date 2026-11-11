import { expect, test, type Page } from '@playwright/test'

const resetMarketplace = async (page: Page) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Seja dono do futuro da arte digital.' })).toBeVisible()
  await page.evaluate(async () => {
    const response = await fetch('/api/__test/reset', { method: 'POST' })
    if (!response.ok) throw new Error(`Mock reset failed: ${response.status}`)
  })
}

const setNetworkMode = async (
  page: Page,
  mode: 'normal' | 'variable-latency' | 'out-of-order' | 'timeout' | 'offline' | 'http-4xx' | 'http-5xx',
) => {
  await page.evaluate(async (nextMode) => {
    const response = await fetch('/api/__test/network-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nextMode }),
    })
    if (!response.ok) throw new Error(`Network scenario failed: ${response.status}`)
  }, mode)
}

const waitForMockSocket = async (page: Page) => {
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch('/api/__test/status')
    if (!response.ok) return 0
    const status = await response.json() as { socketClients: number }
    return status.socketClients
  })).toBeGreaterThan(0)
}

test.beforeEach(async ({ page }) => {
  await resetMarketplace(page)
})

test('catalog filters, sorting, pagination, and browser history keep URL state', async ({ page }) => {
  await expect(page.getByText('Page 1 of 2')).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(page.getByText('Page 2 of 2')).toBeVisible()
  await page.goBack()
  await expect(page.getByText('Page 1 of 2')).toBeVisible()

  await page.getByRole('textbox', { name: 'Search by collection or artist' }).fill('Mira')
  await expect(page).toHaveURL(/search=Mira/)
  await expect(page.getByRole('heading', { name: 'Glass Horizon' })).toBeVisible()
  await page.getByRole('button', { name: 'Photography' }).click()
  await expect(page).toHaveURL(/category=Photography/)
  await expect(page.getByRole('heading', { name: 'Glass Horizon' })).toBeVisible()
  await page.locator('select').selectOption('price-low')
  await expect(page).toHaveURL(/sort=price-low/)
  await expect(page).toHaveURL(/page=1/)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Glass Horizon' })).toBeVisible()
})

test('direct NFT routes render details and show missing resources', async ({ page }) => {
  await page.goto('/nft/nft-001')
  await expect(page.getByRole('heading', { name: 'Neon Pulse' })).toBeVisible()
  await expect(page.getByText('Preço atual')).toBeVisible()

  await page.goto('/nft/not-a-real-nft')
  await expect(page.getByText('This NFT is unavailable.')).toBeVisible()
})

test('catalog monkey artwork loads locally with the animated artwork treatment', async ({ page }) => {
  const artwork = page.locator('article .nft-artwork img')
  await expect(artwork).toHaveCount(6)
  await expect.poll(() => artwork.evaluateAll((images) => images.every(
    (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
  ))).toBe(true)

  const loadedArtwork = await artwork.evaluateAll((images) => images.map((image) => ({
    local: image instanceof HTMLImageElement && new URL(image.currentSrc).pathname.startsWith('/nfts/'),
    animated: image instanceof HTMLImageElement && getComputedStyle(image).animationName === 'nft-artwork-float',
  })))

  expect(loadedArtwork.every((image) => image.local && image.animated)).toBe(true)
})

test('network failures recover and variable delays do not leave stale catalog results', async ({ page }) => {
  await setNetworkMode(page, 'http-5xx')
  await page.getByRole('textbox', { name: 'Search by collection or artist' }).fill('Mira')
  await expect(page.getByRole('alert')).toContainText('Unable to load NFTs.')

  await setNetworkMode(page, 'normal')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Glass Horizon' })).toBeVisible()

  const search = page.getByRole('textbox', { name: 'Search by collection or artist' })
  await setNetworkMode(page, 'variable-latency')
  await search.fill('Neon')
  await expect(page.locator('article').getByRole('heading', { name: 'Neon Pulse' })).toBeVisible()

  await setNetworkMode(page, 'out-of-order')
  await search.clear()
  await search.pressSequentially('Mira', { delay: 5 })
  await expect(page.getByRole('heading', { name: 'Glass Horizon' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('article').getByRole('heading', { name: 'Neon Pulse' })).toHaveCount(0)
})

test('offline and network timeout scenarios show retryable errors', async ({ page }) => {
  await setNetworkMode(page, 'offline')
  await page.getByRole('textbox', { name: 'Search by collection or artist' }).fill('Mira')
  await expect(page.getByRole('alert')).toContainText('Unable to load NFTs.')

  await setNetworkMode(page, 'timeout')
  await page.getByRole('textbox', { name: 'Search by collection or artist' }).fill('Neon')
  await expect(page.getByRole('alert')).toContainText('Unable to load NFTs.', { timeout: 15_000 })
})

test('Socket.IO price updates refresh checkout totals and require renewed confirmation', async ({ page }) => {
  await expect(page.getByRole('link', { name: /Maya/ })).toBeVisible()
  await page.goto('/checkout')
  await expect(page.getByRole('heading', { name: 'Complete your purchase' })).toBeVisible()
  await waitForMockSocket(page)

  await page.evaluate(async () => {
    const response = await fetch('/api/__test/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'nft.updated',
        resourceId: 'nft-002',
        version: 1,
        data: { price: '0.50', available: 8 },
      }),
    })
    if (!response.ok) throw new Error(`Socket scenario failed: ${response.status}`)
  })

  await expect(page.getByRole('alert')).toContainText('price or availability changed')
  await expect(page.getByText('1.000 ETH').first()).toBeVisible()
  await page.getByRole('button', { name: 'Review updated quote' }).click()
  await expect(page.getByRole('button', { name: 'Confirm purchase' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm purchase' }).click()
  await expect(page.getByRole('heading', { name: 'Your purchase is locked in.' })).toBeVisible()
})

test('duplicate and out-of-order Socket.IO events do not revert a newer catalog value', async ({ page }) => {
  await waitForMockSocket(page)
  const publish = async (version: number, price: string, duplicate = false) => page.evaluate(
    async ({ version, price, duplicate }) => {
      const response = await fetch('/api/__test/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'nft.updated',
          resourceId: 'nft-001',
          version,
          data: { price, available: 9 },
          duplicate,
        }),
      })
      if (!response.ok) throw new Error(`Socket scenario failed: ${response.status}`)
    },
    { version, price, duplicate },
  )

  await publish(2, '0.90', true)
  await expect(page.getByText('0.900 ETH')).toBeVisible()
  await publish(1, '9.99')
  await expect(page.getByText('0.900 ETH')).toBeVisible()
  await expect(page.getByText('9.990 ETH')).toHaveCount(0)
})

test('mobile navigation and the main screens have no horizontal overflow at required widths', async ({ page }) => {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Seja dono do futuro da arte digital.' })).toBeVisible()
    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(hasOverflow, `horizontal overflow at ${width}px`).toBe(false)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Wallets' }).click()
  await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()
})

test('signup, login, session expiration, logout, and account switching work', async ({ page }) => {
  await page.getByRole('button', { name: 'Logout' }).click()
  await page.getByRole('link', { name: 'Login' }).click()
  await page.getByLabel('Email').fill('unknown@jungle.io')
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page.getByRole('alert')).toContainText('Invalid credentials')

  await page.getByLabel('Email').fill('maya@jungle.io')
  await page.getByLabel('Password').fill('demo123')
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page.getByText('Welcome back, Maya')).toBeVisible()

  await page.getByRole('button', { name: 'Logout' }).click()
  await page.goto('/signup')
  await page.getByLabel('Full name').fill('Ava Brooks')
  await page.getByLabel('Email').fill('ava@jungle.io')
  await page.getByLabel('Password').fill('pass123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText('Welcome back, Ava')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Welcome back, Ava')).toBeVisible()

  await page.evaluate(async () => {
    const response = await fetch('/api/__test/session-expiry', { method: 'POST' })
    if (!response.ok) throw new Error(`Session expiry scenario failed: ${response.status}`)
  })
  await page.reload()
  await expect(page.getByRole('link', { name: 'Login' })).toBeVisible()
  await page.goto('/login')
  await page.getByLabel('Email').fill('maya@jungle.io')
  await page.getByLabel('Password').fill('demo123')
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page.getByText('Welcome back, Maya')).toBeVisible()
})

test('switching users isolates private data and merges the guest cart into the next account', async ({ page }) => {
  await page.getByRole('button', { name: 'Logout' }).click()
  await expect(page.getByRole('link', { name: 'Login' })).toBeVisible()
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Neon Pulse' }) })
    .getByRole('button', { name: 'Buy now' }).click()
  await page.getByRole('link', { name: 'Login' }).click()
  await page.getByLabel('Email').fill('alex@jungle.io')
  await page.getByLabel('Password').fill('demo123')
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page.getByText('Welcome back, Alex')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add Glass Horizon to favorites' })).toHaveAttribute('aria-pressed', 'false')
  await page.locator('header a[href="/cart"]').click()
  await expect(page.getByRole('heading', { name: 'Your selected pieces' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Neon Pulse' }).last()).toBeVisible()
  await expect(page.getByTestId('cart-items').getByRole('heading', { name: 'Midnight Runner' })).toHaveCount(0)
})

test('profile, password, and wallet changes persist and return API validation errors', async ({ page }) => {
  await page.goto('/profile')
  await page.getByLabel('Name', { exact: true }).fill('Maya Chen Updated')
  await page.getByLabel('Avatar image URL (HTTPS)').fill('https://example.com/maya-avatar.png')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByRole('status')).toContainText('Profile updated.')
  await page.reload()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maya Chen Updated')

  await page.getByLabel('Current password').fill('demo123')
  await page.getByLabel('New password', { exact: true }).fill('NewDemo123')
  await page.getByLabel('Confirm new password', { exact: true }).fill('NewDemo123')
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByRole('status')).toContainText('Password updated.')

  await page.goto('/wallets')
  await page.getByLabel('Wallet label').fill('Test wallet')
  await page.getByLabel('Wallet address').fill('0x123456789abcdef')
  await page.getByLabel('Network').selectOption('Polygon')
  await page.getByRole('button', { name: 'Add wallet' }).click()
  await expect(page.getByRole('status')).toContainText('Wallet added.')

  await page.getByRole('button', { name: 'Edit Test wallet' }).click()
  await page.getByLabel('Wallet address').fill('0x987654321abcdef')
  await page.getByLabel('Network').selectOption('Solana')
  await page.getByRole('button', { name: 'Save wallet' }).click()
  await expect(page.getByRole('status')).toContainText('Wallet updated.')
  await page.getByRole('button', { name: 'Set Test wallet as primary' }).click()
  await expect(page.getByRole('status')).toContainText('Primary wallet updated.')

  await page.getByLabel('Wallet label').fill('Duplicate wallet')
  await page.getByLabel('Wallet address').fill('0xA1D5...7EF2')
  await page.getByRole('button', { name: 'Add wallet' }).click()
  await expect(page.locator('form').getByRole('alert')).toContainText('already saved')
})

test('session expiration during checkout returns to login and resumes checkout', async ({ page }) => {
  await page.goto('/checkout')
  await expect(page.getByRole('heading', { name: 'Complete your purchase' })).toBeVisible()
  await page.evaluate(async () => {
    const response = await fetch('/api/__test/session-expiry', { method: 'POST' })
    if (!response.ok) throw new Error(`Session expiry scenario failed: ${response.status}`)
  })

  await page.getByRole('button', { name: 'Confirm purchase' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('Email').fill('maya@jungle.io')
  await page.getByLabel('Password').fill('demo123')
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page.getByRole('heading', { name: 'Complete your purchase' })).toBeVisible()
  await expect(page.getByText('Midnight Runner')).toBeVisible()
})

test('favorite failures roll back and cart quantity and coupon state survive refresh', async ({ page }) => {
  await page.evaluate(async () => {
    const response = await fetch('/api/__test/fail-next-favorite', { method: 'POST' })
    if (!response.ok) throw new Error(`Favorite failure scenario failed: ${response.status}`)
  })
  const favorite = page.getByRole('button', { name: 'Add Neon Pulse to favorites' })
  await favorite.click()
  await expect(page.getByRole('status')).toContainText('previous selection was restored')
  await expect(page.getByRole('button', { name: 'Add Neon Pulse to favorites' })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Add Neon Pulse to favorites' }).click()
  await expect(page.getByRole('button', { name: 'Remove Neon Pulse from favorites' })).toHaveAttribute('aria-pressed', 'true')

  await page.goto('/cart')
  await page.getByRole('button', { name: 'Increase Midnight Runner quantity' }).click()
  await expect(page.getByLabel('Quantity 3')).toBeVisible()
  await page.getByLabel('Coupon code').fill('WELCOME10')
  await page.getByRole('button', { name: 'Aplicar' }).click()
  await expect(page.getByText('Coupon WELCOME10 applied')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Quantity 3')).toBeVisible()
})

test('payment failure preserves the cart and a timed-out order can be retried', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/checkout')
  const setOrderMode = async (mode: 'payment-failure' | 'timeout' | 'success') => page.evaluate(
    async (nextMode) => {
      const response = await fetch('/api/__test/order-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode }),
      })
      if (!response.ok) throw new Error(`Order scenario failed: ${response.status}`)
    },
    mode,
  )

  await setOrderMode('payment-failure')
  await page.getByRole('button', { name: 'Confirm purchase' }).click()
  await expect(page.getByRole('alert')).toContainText('order is refused')
  await expect(page.getByText('Midnight Runner')).toBeVisible()

  await setOrderMode('timeout')
  await page.getByRole('button', { name: 'Confirm purchase' }).click()
  await expect(page.getByRole('button', { name: 'Processing...' })).toBeDisabled()
  await expect(page.getByRole('alert')).toContainText('timed out')
  await page.waitForTimeout(1000)
  await setOrderMode('success')
  await page.getByRole('button', { name: 'Confirm purchase' }).click()
  await expect(page.getByRole('heading', { name: 'Your purchase is locked in.' })).toBeVisible()
})

test('home, detail, cart, and checkout match desktop and mobile visual baselines', async ({ page }) => {
  test.setTimeout(120_000)
  const screens = [
    { name: 'home', path: '/', heading: 'Seja dono do futuro da arte digital.' },
    { name: 'detail', path: '/nft/nft-001', heading: 'Neon Pulse' },
    { name: 'cart', path: '/cart', heading: 'Your selected pieces' },
    { name: 'checkout', path: '/checkout', heading: 'Complete your purchase' },
  ]

  await page.goto('/')
  await expect(page.getByRole('link', { name: /Maya/ })).toBeVisible()

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    for (const screen of screens) {
      await page.goto(screen.path)
      await expect(page.getByRole('heading', { name: screen.heading })).toBeVisible()
      await expect(page).toHaveScreenshot(`${screen.name}-${width}.png`, {
        fullPage: true,
        animations: 'disabled',
        mask: [page.locator('img')],
        maskColor: '#374151',
      })
    }
  }
})
