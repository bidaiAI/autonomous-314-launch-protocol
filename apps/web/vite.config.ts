import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

function buildProxy(path: string, target: string | undefined) {
  const normalizedTarget = target?.trim();
  if (!normalizedTarget || !/^https?:\/\//i.test(normalizedTarget)) {
    return null;
  }

  const proxy: ProxyOptions = {
    target: normalizedTarget,
    changeOrigin: true,
    secure: true,
    rewrite: (requestPath) => requestPath.replace(new RegExp(`^${path}`), "")
  };

  return [path, proxy] as const;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyEntries = [
    buildProxy("/__proxy/indexer", env.VITE_INDEXER_API_URL),
    buildProxy("/__proxy/base-indexer", env.VITE_BASE_INDEXER_API_URL),
    buildProxy("/api/coingecko", "https://api.coingecko.com")
  ].filter((entry): entry is readonly [string, ProxyOptions] => Boolean(entry));

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            viem: ["viem", "viem/chains"]
          }
        }
      }
    },
    server: {
      host: "0.0.0.0",
      port: 4173,
      proxy: Object.fromEntries(proxyEntries)
    }
  };
});
