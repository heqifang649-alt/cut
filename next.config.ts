import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep production output separate from stale legacy .next artifacts.
  // The launcher invokes `next start`, which automatically honors this path.
  distDir: ".next-runtime",
};

export default nextConfig;
