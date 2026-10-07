import { OwnerHost } from "../adapters/host/owner.js";
import { startHostServer } from "../adapters/host/rpc.js";
import { createKernel } from "../composition.js";
import { type ApiConfig, configFromEnv } from "../config.js";

async function main(config: ApiConfig) {
  const kernel = await createKernel(config);
  const host = await startHostServer(config.dataDir, new OwnerHost(config.dataDir));
  kernel.worker.start();
  process.send?.({ type: "ready" });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await kernel.worker.close();
    await host.close();
    await kernel.db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
  process.on("disconnect", () => void close());
}
if (process.send)
  process.once("message", (message: any) => {
    void main(message.config).catch((error) => {
      console.error("[worker:start]", error.message);
      process.exit(1);
    });
  });
else await main(configFromEnv());
