import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep production output separate from stale legacy .next artifacts.
  // The launcher invokes `next start`, which automatically honors this path.
  // Allow an isolated candidate build/runtime without replacing the currently
  // serving production build. Normal launches retain the established path.
  distDir: process.env.CUTFLOW_NEXT_DIST_DIR || ".next-runtime",
  // Persistent runtime data is mounted beside the application but is not a
  // build input. In particular, private backups can have intentionally
  // restricted ACLs and must never be traversed by output file tracing.
  outputFileTracingExcludes: {
    "*": [
      "./data/private-backups/**/*",
      "./data/**/private-backups/**/*",
      "./storage/**/*",
      "./logs/**/*",
      "./outputs/**/*",
      "./work/**/*",
      "./.tmp/**/*",
    ],
  },
  // Allow the local LAN URL used by the Cut desktop/workspace preview to load
  // Next.js development resources such as HMR and the bundled fonts.
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.30.38"],
};

export default nextConfig;
