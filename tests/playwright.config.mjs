import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90000,
  expect: { timeout: 20000 },
  // One server with a shared stand-in database, and a software-rendered map that's heavy to run.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 800 },
    geolocation: { latitude: 1.3048, longitude: 103.8318 },
    permissions: ['geolocation'],
    launchOptions: {
      // WebGL with no GPU, for MapLibre.
      args: [
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        // Ads and analytics add nothing here but time.
        '--host-resolver-rules=MAP www.googletagmanager.com ~NOTFOUND, MAP pagead2.googlesyndication.com ~NOTFOUND',
      ],
    },
  },
  webServer: {
    command: 'node dev-server.mjs',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: true,
    stdout: 'pipe',
  },
});
