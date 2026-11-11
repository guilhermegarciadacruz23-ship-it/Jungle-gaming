import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { launch as launchChrome } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import { chromium } from '@playwright/test'
import { preview } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const outputDirectory = resolve(root, 'lighthouse-reports')
const host = '127.0.0.1'
const port = Number(process.env.LIGHTHOUSE_PORT ?? 4174)
const runsPerProfile = 3
const categories = ['performance', 'accessibility', 'best-practices', 'seo']
const pages = [
  { name: 'home', path: '/' },
  { name: 'nft-detail', path: '/nft/nft-001' },
]
/** @type {Array<{name: string, formFactor: 'mobile' | 'desktop', width: number, height: number, mobile: boolean}>} */
const profiles = [
  { name: 'mobile', formFactor: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'desktop', formFactor: 'desktop', width: 1440, height: 900, mobile: false },
]

/** @param {Array<number | null>} values */
const median = (values) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b)
  if (sorted.length === 0) throw new Error('Cannot calculate a median without numeric measurements.')
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** @param {string} name */
const packageVersion = async (name) => {
  const packagePath = resolve(root, 'node_modules', name, 'package.json')
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  return pkg.version
}

/** @param {string | string[]} report */
const toReportFiles = (report) => Array.isArray(report) ? report : [report]

const server = await preview({
  configFile: resolve(root, 'vite.config.ts'),
  preview: { host, port, strictPort: true },
})

const baseUrl = server.resolvedUrls?.local[0] ?? `http://${host}:${port}/`
const results = []

try {
  await mkdir(outputDirectory, { recursive: true })

  for (const page of pages) {
    for (const profile of profiles) {
      /** @type {Array<{run: number, scores: Record<string, number>, metrics: {lcpMs: number | null, cls: number | null, tbtMs: number | null}}>} */
      const measurements = []
      const reportDirectory = resolve(outputDirectory, page.name, profile.name)
      await mkdir(reportDirectory, { recursive: true })

      for (let run = 1; run <= runsPerProfile; run += 1) {
        const chrome = await launchChrome({
          chromePath: chromium.executablePath(),
          chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
          logLevel: 'error',
        })

        try {
          const result = await lighthouse(
            new URL(page.path, baseUrl).toString(),
            {
              port: chrome.port,
              logLevel: 'error',
              output: ['html', 'json'],
              onlyCategories: categories,
              formFactor: profile.formFactor,
              screenEmulation: {
                mobile: profile.mobile,
                width: profile.width,
                height: profile.height,
                deviceScaleFactor: 1,
                disabled: false,
              },
              throttlingMethod: profile.mobile ? 'simulate' : 'provided',
            },
          )

          if (!result) throw new Error(`Lighthouse returned no result for ${page.name}/${profile.name}.`)
          const [htmlReport, jsonReport] = toReportFiles(result.report)
          await writeFile(resolve(reportDirectory, `run-${run}.html`), htmlReport)
          await writeFile(resolve(reportDirectory, `run-${run}.json`), jsonReport)

          /** @param {string} id */
          const metric = (id) => result.lhr.audits[id]?.numericValue ?? null
          measurements.push({
            run,
            scores: Object.fromEntries(
              categories.map((category) => [
                category,
                Math.round((result.lhr.categories[category]?.score ?? 0) * 100),
              ]),
            ),
            metrics: {
              lcpMs: metric('largest-contentful-paint'),
              cls: metric('cumulative-layout-shift'),
              tbtMs: metric('total-blocking-time'),
            },
          })
          console.log(`Completed Lighthouse ${page.name}/${profile.name} run ${run}/${runsPerProfile}.`)
        } finally {
          await chrome.kill()
        }
      }

      const summary = {
        page: page.name,
        path: page.path,
        profile: profile.name,
        runs: measurements,
        median: {
          scores: Object.fromEntries(
            categories.map((category) => [
              category,
              median(measurements.map((entry) => entry.scores[category])),
            ]),
          ),
          metrics: {
            lcpMs: median(measurements.map((entry) => entry.metrics.lcpMs)),
            cls: median(measurements.map((entry) => entry.metrics.cls)),
            tbtMs: median(measurements.map((entry) => entry.metrics.tbtMs)),
          },
        },
      }
      results.push(summary)
      await writeFile(resolve(reportDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
      console.log(
        `${page.name}/${profile.name} median: ` +
          `performance ${summary.median.scores.performance}, ` +
          `accessibility ${summary.median.scores.accessibility}, ` +
          `best practices ${summary.median.scores['best-practices']}, ` +
          `SEO ${summary.median.scores.seo}, ` +
          `LCP ${summary.median.metrics.lcpMs} ms, ` +
          `CLS ${summary.median.metrics.cls}, ` +
          `TBT ${summary.median.metrics.tbtMs} ms`,
      )
    }
  }

  const metadata = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    lighthouseVersion: await packageVersion('lighthouse'),
    chromeLauncherVersion: await packageVersion('chrome-launcher'),
    browser: 'Playwright Chromium',
    baseUrl,
    runsPerProfile,
    throttling: {
      mobile: 'Lighthouse simulated mobile throttling',
      desktop: 'Lighthouse provided (unthrottled) desktop profile',
    },
  }
  const report = { metadata, results }
  await writeFile(resolve(outputDirectory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  const rows = results.map((entry) => `
    <tr>
      <td>${entry.page}</td><td>${entry.profile}</td>
      <td>${entry.median.scores.performance}</td><td>${entry.median.scores.accessibility}</td>
      <td>${entry.median.scores['best-practices']}</td><td>${entry.median.scores.seo}</td>
      <td>${entry.median.metrics.lcpMs}</td><td>${entry.median.metrics.cls}</td><td>${entry.median.metrics.tbtMs}</td>
    </tr>`).join('')
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Lighthouse audit summary</title>
<style>body{font:16px system-ui;margin:2rem;color:#172033}table{border-collapse:collapse}th,td{border:1px solid #ccd2dd;padding:.5rem}th{background:#edf0f7}code{overflow-wrap:anywhere}</style>
<h1>Lighthouse audit summary</h1>
<p>Generated ${metadata.generatedAt}; Lighthouse ${metadata.lighthouseVersion}; ${metadata.browser}; ${metadata.platform}; Node ${metadata.node}.</p>
<p>URL: <code>${baseUrl}</code>. Three runs per page and profile; medians shown.</p>
<table><thead><tr><th>Page</th><th>Profile</th><th>Performance</th><th>Accessibility</th><th>Best practices</th><th>SEO</th><th>LCP (ms)</th><th>CLS</th><th>TBT (ms)</th></tr></thead><tbody>${rows}</tbody></table>
<p>Individual Lighthouse HTML and JSON reports are saved beside each profile's summary.json.</p></html>`
  await writeFile(resolve(outputDirectory, 'summary.html'), html)
} finally {
  await server.close()
}
