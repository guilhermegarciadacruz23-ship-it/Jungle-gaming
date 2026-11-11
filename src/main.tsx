import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
    },
  },
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Application root element was not found.')
}

const root = createRoot(rootElement)
const startupTimeoutMs = 12_000
let startupTimer: number | undefined

const renderStartupMessage = (message: string, showRecovery = false) => {
  root.render(
    <main className="flex min-h-screen items-center justify-center bg-[#050816] px-6 text-slate-100">
      <section
        className="w-full max-w-lg rounded-3xl border border-white/10 bg-slate-900/80 p-8 text-center shadow-2xl"
        role={showRecovery ? 'alert' : 'status'}
        aria-live={showRecovery ? 'assertive' : 'polite'}
      >
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-400 to-cyan-400 font-black text-slate-950">
          J
        </div>
        <h1 className="text-xl font-bold">Jungle Gaming</h1>
        <p className="mt-3 text-sm text-slate-300">{message}</p>
        {showRecovery && (
          <button
            type="button"
            onClick={() => void recoverStartup()}
            className="mt-6 rounded-full bg-violet-600 px-5 py-3 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
          >
            Retry startup
          </button>
        )}
      </section>
    </main>,
  )
}

const recoverStartup = async () => {
  let recoveryTimer: number | undefined
  try {
    if ('serviceWorker' in navigator) {
      const cleanup = async () => {
        const registrations = await navigator.serviceWorker.getRegistrations()
        const appScope = `${window.location.origin}/`
        await Promise.all(
          registrations
            .filter((registration) => registration.scope === appScope)
            .map((registration) => registration.unregister()),
        )
      }
      const completed = await Promise.race([
        cleanup().then(() => true),
        new Promise<boolean>((resolve) => {
          recoveryTimer = window.setTimeout(() => resolve(false), 2_000)
        }),
      ])
      if (!completed) console.warn('Service worker cleanup timed out; reloading the application anyway.')
    }
  } catch (error: unknown) {
    console.error('Unable to recover the application service worker.', error)
  } finally {
    if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer)
  }
  window.location.reload()
}

const bootstrap = async () => {
  renderStartupMessage('Starting the marketplace and its demo services…')
  startupTimer = window.setTimeout(() => {
    renderStartupMessage('Startup is taking longer than expected. Retry to recover the demo service worker.', true)
  }, startupTimeoutMs)

  try {
    if (import.meta.env.VITE_ENABLE_MOCKS !== 'false') {
      const { startMocks } = await import('./lib/msw')
      await startMocks()
    }

    if (startupTimer !== undefined) window.clearTimeout(startupTimer)
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </StrictMode>,
    )
  } catch (error: unknown) {
    if (startupTimer !== undefined) window.clearTimeout(startupTimer)
    console.error('Unable to start the application.', error)
    renderStartupMessage('The marketplace could not start its demo services. Retry to recover and reload.', true)
  }
}

void bootstrap()
