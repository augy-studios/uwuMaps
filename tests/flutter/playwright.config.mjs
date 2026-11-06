import { defineConfig } from '@playwright/test';

// The Android app's Dart code in a browser, at a phone's size. See tests/flutter/serve.mjs.
export default defineConfig({
  testDir: './e2e',
  timeout: 120000,
  expect: { timeout: 30000 },
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: 'http://127.0.0.1:4180',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    screenshot: 'only-on-failure',
    hasTouch: false,
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    geolocation: { latitude: 1.3048, longitude: 103.8318 },
    permissions: ['geolocation'],
    launchOptions: {
      // WebGL with no GPU, for the map.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: [
    { command: 'node ../dev-server.mjs', url: 'http://127.0.0.1:4173/', reuseExistingServer: true, stdout: 'pipe' },
    { command: 'node serve.mjs', url: 'http://127.0.0.1:4180/', reuseExistingServer: true, stdout: 'pipe' },
  ],
});
