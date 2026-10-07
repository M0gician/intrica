import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalBackend } from "./runtime.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const configPath =
  process.env.INTRICA_SERVICE_CONFIG ?? join(homedir(), ".config/intrica/server.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (
  !config.accessToken ||
  !config.databasePassword ||
  !config.stateDir ||
  !config.host ||
  !Number.isInteger(config.port) ||
  config.port < 1 ||
  config.port > 65535
)
  throw new Error(`Invalid server configuration: ${configPath}`);
const release = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
process.env.INTRICA_SERVICE_CONFIG = configPath;
process.env.INTRICA_COMMIT = release.commit;
process.env.INTRICA_WORKSPACE_DIR ??= homedir();
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;

let backend;
let startup;
let closing;
const close = () =>
  (closing ??= (async () => {
    await startup?.catch(() => {});
    await backend?.close();
  })());
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });

try {
  startup = startLocalBackend({
    userData: config.stateDir,
    schemaFile: join(directory, "db/schema.sql"),
    webRoot: join(directory, "web"),
    host: config.host,
    port: config.port,
    accessToken: config.accessToken,
    databasePassword: config.databasePassword,
    serverName: config.serverName,
    deployment: "service",
  }).then((result) => {
    backend = result;
  });
  await startup;
  console.log(
    `Intrica Server ${release.version} listening on ${config.host}:${config.port} (local URL ${backend.apiUrl})`,
  );
} catch (error) {
  console.error(error);
  await close();
  process.exitCode = 1;
}
