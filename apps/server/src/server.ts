#!/usr/bin/env node
import { buildServer } from "./app.js";
import { parseServerArgs } from "./cli.js";
import { configFromEnv } from "./config.js";

const config = { ...configFromEnv(), ...parseServerArgs(process.argv.slice(2)) };
const app = await buildServer(config);
const address = await app.listen({ port: config.port, host: config.host });
console.log(`intrica server listening on ${address}`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
