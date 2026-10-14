import { readDirectory } from "./directory.js";
import { editText, writeText } from "./edit.js";
import { readText } from "./text.js";

// Fixed entry point: input is operation data, never model-generated JavaScript.
try {
  const { name, path, args, temporary } = JSON.parse(process.argv[2]!);
  const value =
    name === "read"
      ? await readText(path, args)
      : name === "list_directory"
        ? await readDirectory(path, args)
        : name === "write"
          ? await writeText(path, temporary, args.content)
          : name === "edit"
            ? await editText(path, temporary, args.edits)
            : null;
  if (!value)
    throw Object.assign(new Error("Unknown file operation / 未知文件操作"), { code: "VALIDATION" });
  process.stdout.write(JSON.stringify({ value }));
} catch (error) {
  const failure = error as { code?: string; message: string; effect?: string };
  process.stdout.write(
    JSON.stringify({
      error: {
        code: failure.code ?? "IO_ERROR",
        message: failure.message,
        effect: failure.effect ?? "unknown",
      },
    }),
  );
  process.exitCode = 1;
}
