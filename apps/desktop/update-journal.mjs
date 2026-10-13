import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const updateJournalPath = (userData) => join(userData, "updates", "operation.json");
export async function readUpdateOperation(userData) {
  try {
    const value = JSON.parse(await readFile(updateJournalPath(userData), "utf8"));
    return value.format === 1 && typeof value.id === "string" ? value : null;
  } catch {
    return null;
  }
}
export async function writeUpdateOperation(userData, operation) {
  const path = updateJournalPath(userData);
  await mkdir(join(userData, "updates"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ ...operation, format: 1, updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  await rename(temporary, path);
}
export async function markUpdateStartup(userData, version, error) {
  const operation = await readUpdateOperation(userData);
  if (
    !operation ||
    operation.targetVersion !== version ||
    !["installing", "restarting", "validating"].includes(operation.phase)
  )
    return;
  await writeUpdateOperation(userData, {
    ...operation,
    phase: error ? "failed" : "validating",
    migrationMayHaveStarted: true,
    ...(error ? { error: "UPDATE_START_FAILED" } : {}),
  });
}
