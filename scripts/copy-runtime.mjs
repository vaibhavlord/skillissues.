import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("pyodide/package.json");
const { version } = JSON.parse(await readFile(manifestPath, "utf8"));
const packageDirectory = dirname(manifestPath);
const runtimeDirectory = new URL(`../web/runtime/v${version}/`, import.meta.url);
const files = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

await mkdir(runtimeDirectory, { recursive: true });
await Promise.all(files.map((file) =>
  copyFile(join(packageDirectory, file), new URL(file, runtimeDirectory))
));
console.log(`Copied Pyodide ${version} into the static site.`);
