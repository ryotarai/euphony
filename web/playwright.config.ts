import { defineConfig, devices } from "@playwright/test";

const requestedPort = process.env.EUPHONY_E2E_PORT;
const port = requestedPort && /^\d+$/.test(requestedPort) ? requestedPort : "18080";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      `npm run build && cd .. && mkdir -p bin && go build -trimpath -o bin/euphony ./cmd/euphony && EUPHONY_DB=:memory: EUPHONY_TOKEN=test-token EUPHONY_ADDR=127.0.0.1:${port} CLAUDE_CONFIG_DIR=/tmp/euphony-e2e-${port}-claude CODEX_HOME=/tmp/euphony-e2e-${port}-codex bin/euphony`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
