// End-to-end tests for Magic Screen in Chromium (desktop + phone emulation).
// Chromium's fake camera plays e2e/fixtures/fake-greenscreen.y4m: a synthetic child
// waving in front of a chroma-green backdrop, so the real keyer path is exercised.
import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_CAMERA = path.join(here, 'e2e', 'fixtures', 'fake-greenscreen.y4m')
// PW_PORT lets parallel agents/servers pick their own port (default 5174).
const PORT = Number(process.env.PW_PORT ?? 5174)

const chromiumMedia = {
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${FAKE_CAMERA}`,
    // Headless autoplay policy would otherwise block the Keep step's <video autoplay>.
    '--autoplay-policy=no-user-gesture-required',
  ],
}

export default defineConfig({
  testDir: './e2e',
  // Only *.spec.ts: e2e/harness also holds vitest unit tests (*.test.ts).
  testMatch: '**/*.spec.ts',
  // Each test drives a live camera + WebGL keyer; keep them serial per worker and
  // give the camera/recording flows room to breathe.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    permissions: ['camera', 'microphone'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: chromiumMedia,
      },
    },
    {
      name: 'chromium-phone',
      use: {
        // iPhone 14 viewport/touch/UA, but run in Chromium (fake camera flags are Chromium-only).
        ...devices['iPhone 14'],
        browserName: 'chromium',
        launchOptions: chromiumMedia,
      },
    },
  ],
})
