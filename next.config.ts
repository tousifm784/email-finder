import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["bullmq", "ioredis"],
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;