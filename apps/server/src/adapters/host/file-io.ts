import { fileURLToPath } from "node:url";
export const FILE_IO_ENTRY = fileURLToPath(
  new URL(
    "./files/entry.js",
    import.meta.url.replace("/src/adapters/host/", "/dist/adapters/host/"),
  ),
).replace(/\.asar([/\\])/, ".asar.unpacked$1");
