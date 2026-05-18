import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_PAGES && !process.env.CUSTOM_DOMAIN ? "/op-fingerprint-reading-tool/" : "/",
});
