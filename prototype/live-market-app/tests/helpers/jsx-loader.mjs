// A minimal loader so a node test can import the real app source.
//
// JSX and `import.meta.env` are build-time concerns that Vite handles for the
// browser. A render test needs the same two things and nothing else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

export async function load(url, context, nextLoad) {
  if (!/\.jsx?$/.test(url) || url.includes("/node_modules/")) return nextLoad(url, context);

  const source = readFileSync(fileURLToPath(url), "utf8");
  const { code } = transformSync(source, {
    loader: url.endsWith(".jsx") ? "jsx" : "js",
    // The automatic runtime, as the Vite plugin uses: the source never imports
    // React itself.
    jsx: "automatic",
    format: "esm",
    target: "node20",
    // The app reads configuration from import.meta.env; a test supplies none,
    // which is exactly the "nothing configured" case worth rendering.
    define: { "import.meta.env": "globalThis.__VITE_ENV__" },
  });
  return { format: "module", source: code, shortCircuit: true };
}
