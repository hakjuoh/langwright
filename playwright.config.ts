import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './examples',
  fullyParallel: false,
  timeout: 60_000,
  reporter: [
    ['line'],
    ['html', {
      open: 'never'
    }
    ]
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--proxy-server=direct://', '--proxy-bypass-list=*'],
        },
      },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ]
});
