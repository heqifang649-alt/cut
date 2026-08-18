import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep production output separate from stale legacy .next artifacts.
  // The launcher invokes `next start`, which automatically honors this path.
  distDir: ".next-runtime",
  // Allow the local LAN URL used by the Cut desktop/workspace preview to load
  // Next.js development resources such as HMR and the bundled fonts.
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.30.38"],
};

export default nextConfig;
