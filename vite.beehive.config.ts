import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Beehive page that the engine serves at /beehive/ for the iOS app. It has its own document
// and bundle, with no relay, Buzz sign-in or identity, so it shares nothing with the desktop
// build's configuration.
export default defineConfig({
  root: "src/features/beehive/standalone",
  plugins: [react()],
  // Keep this build's cache apart from the desktop dev server's.
  cacheDir: "../../../../node_modules/.vite-beehive",
  publicDir: false,
  base: "/beehive/",
  build: {
    outDir: "../../../../dist-beehive",
    emptyOutDir: true,
    // The engine's content policy has no data: font source, so serve every asset as a file.
    assetsInlineLimit: 0,
  },
});
