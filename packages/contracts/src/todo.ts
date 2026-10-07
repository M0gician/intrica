/** Initial size only. The web client measures rendered Markdown for selection and connections. */
export function todoHeight(title: string, text: string, width: number): number {
  const charsPerLine = Math.max(16, Math.floor(width / 7));
  const lines = `${title}\n${text || "- [ ] 添加待办事项"}`
    .split("\n")
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  // Keep a comfortable interaction target even for a one-line note.
  return Math.min(420, Math.max(120, 46 + lines * 19));
}

export function todoItems(text: string) {
  let fence = "";
  return text.split("\n").flatMap((line, index) => {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1]![0]!;
      else if (fence === marker[1]![0]) fence = "";
      return [];
    }
    if (fence) return [];
    const match = line.match(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])\s*(.*)$/);
    return match
      ? [{ line: index + 1, completed: match[2]!.toLowerCase() === "x", label: match[4]! }]
      : [];
  });
}
export function setTodoItem(text: string, line: number, completed: boolean): string {
  if (!todoItems(text).some((item) => item.line === line))
    throw new Error("此行不是待办项，请先读取最新内容");
  const lines = text.split("\n");
  lines[line - 1] = lines[line - 1]!.replace(
    /^(\s*(?:[-+*]|\d+[.)])\s+\[)[ xX](\])/,
    `$1${completed ? "x" : " "}$2`,
  );
  return lines.join("\n");
}
