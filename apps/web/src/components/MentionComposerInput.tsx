import type { Node } from "@intrica/contracts";
import type * as React from "react";
import { useMemo, useState } from "react";
import { tr, useTranslation } from "../i18n";
import { nodeDisplayTitle } from "../utils/graph";
import { matchesMention } from "../utils/mention-search";
import { ComposerInput } from "./ComposerInput";
import { IconBrowser, IconGroup, IconImage, IconText } from "./icons";

function canvasNodes(nodes: readonly Node[], canvasId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rootOf = (node: Node) => {
    let current: Node | undefined = node;
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return current?.id;
  };
  return nodes.filter((node) => node.parentId !== null && rootOf(node) === canvasId);
}
function mentionAt(value: string, cursor: number) {
  const match = value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
  return match ? { start: cursor - match[1]!.length - 1, query: match[1]! } : null;
}
export function MentionComposerInput({
  nodes,
  canvasId,
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof ComposerInput>, "value" | "onChange"> & {
  nodes: readonly Node[];
  canvasId: string;
  value: string;
  onChange: React.ChangeEventHandler<HTMLTextAreaElement>;
}) {
  useTranslation();

  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(() => mentionAt(value, value.length));
  const [activeIndex, setActiveIndex] = useState(0);
  const options = useMemo(() => canvasNodes(nodes, canvasId), [nodes, canvasId]);
  const matches = options.filter((node) => matchesMention(node, mention?.query ?? "")).slice(0, 12);
  const updateMention = (nextValue: string, cursor: number) => {
    setMention(mentionAt(nextValue, cursor));
    setActiveIndex(0);
  };
  const choose = (node: Node) => {
    if (!mention) return;
    const title = nodeDisplayTitle(node);
    const next = `${value.slice(0, mention.start)}@${title} ${value.slice(mention.start + mention.query.length + 1)}`;
    onChange({
      target: { value: next, selectionStart: mention.start + title.length + 2 } as EventTarget &
        HTMLTextAreaElement,
      currentTarget: {
        value: next,
        selectionStart: mention.start + title.length + 2,
      } as EventTarget & HTMLTextAreaElement,
    } as React.ChangeEvent<HTMLTextAreaElement>);
    setMention(null);
  };
  const icon = (kind: Node["kind"]) =>
    kind === "image" ? (
      <IconImage size={15} />
    ) : kind === "group" ? (
      <IconGroup size={15} />
    ) : kind === "text" ? (
      <IconText size={15} />
    ) : (
      <IconBrowser size={15} />
    );
  return (
    <div className="mention-composer">
      {mention && matches.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label={tr("引用画布节点")}>
          <div className="mention-menu-heading">
            {tr("引用画布节点")}
            <small>{tr("\u2191\u2193 选择 \u00B7 Enter 插入")}</small>
          </div>
          {matches.map((node) => (
            <button
              key={node.id}
              type="button"
              role="option"
              className={`mention-option${matches[activeIndex]?.id === node.id ? " is-active" : ""}`}
              aria-selected={matches[activeIndex]?.id === node.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(node)}
            >
              <span className="mention-kind-icon" aria-hidden="true">
                {icon(node.kind)}
              </span>
              <span className="mention-option-title" title={nodeDisplayTitle(node)}>
                {nodeDisplayTitle(node)}
              </span>
              <small>{node.kind}</small>
            </button>
          ))}
        </div>
      )}
      <ComposerInput
        {...props}
        value={value}
        onChange={(event) => {
          onChange(event);
          const nextValue = event.target.value;
          const cursor = event.target.selectionStart || nextValue.length;
          updateMention(nextValue, cursor);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && mention) {
            event.preventDefault();
            setMention(null);
            return;
          }
          if (mention && matches.length > 0 && event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % matches.length);
            return;
          }
          if (mention && matches.length > 0 && event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
            return;
          }
          if (mention && matches.length > 0 && event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            choose(matches[activeIndex]!);
            return;
          }
          props.onKeyDown?.(event);
        }}
      />
    </div>
  );
}
