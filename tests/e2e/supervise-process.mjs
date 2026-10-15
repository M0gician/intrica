// Both test servers own a detached process group, including their descendants.
export function superviseProcess(child, cleanup = () => {}) {
  let stopping = false;
  const stopTree = () => {
    if (stopping) return;
    stopping = true;
    cleanup();
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }
  };
  const stop = () => {
    stopTree();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("exit", stopTree);
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
}
