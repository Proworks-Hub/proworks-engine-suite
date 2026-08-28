// Copyright (c) 2026 Steven Kreutzer. All rights reserved.

import { defineConfig } from "vite";
import path from "node:path";

// The demo harness runs the REAL components against a simulator. No React
// plugin: Vite transpiles JSX itself, and the plugin's only real benefit here
// is Fast Refresh, which is not worth pinning the whole repo to a Vite major.
export default defineConfig({
  root: path.resolve(import.meta.dirname),
  esbuild: { jsx: "automatic" },
  server: { port: 5178, host: "127.0.0.1" },
});
