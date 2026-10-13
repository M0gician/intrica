import { useState } from "react";
import { tr } from "../i18n";
import { Button } from "../ui/button";

/** Grow rendered text in bounded steps; the full saved value stays reachable. */
export function ExpandableText({ text, step = 12000 }: { text: string; step?: number }) {
  const [pages, setPages] = useState(1);
  const end = pages * step;
  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable output supports keyboard reading. */}
      <pre tabIndex={0}>{text.slice(0, end)}</pre>
      {text.length > end && (
        <Button onClick={() => setPages((value) => value + 1)}>{tr("显示更多内容")}</Button>
      )}
    </>
  );
}
