// Bundles src/ui/index.tsx to dist/ui/index.js for the host UI loader.
//
// Mirrors the SDK's esbuild UI preset (see createPluginBundlerPresets): the
// browser bundle externalizes react and the host-provided
// @paperclipai/plugin-sdk/ui modules, which the host module registry injects
// at load time.
import { build } from "esbuild";

await build({
  entryPoints: ["src/ui/index.tsx"],
  outdir: "dist/ui",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
    "@paperclipai/plugin-sdk/ui/hooks",
  ],
});

console.log("UI bundle written to dist/ui/index.js");
