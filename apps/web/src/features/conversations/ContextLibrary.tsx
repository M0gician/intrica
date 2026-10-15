import type { ContextLibraryQuery, ContextLibraryResponse } from "@intrica/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client";
import { useSessionConnection } from "../../api/connection";
import { IconBookmark, IconChevronLeft, IconRefresh } from "../../components/icons";
import { date, number, tr, useTranslation } from "../../i18n";
import { toolLabel } from "./tool-display";
import { useContextLibrary } from "./useContextLibrary";

function sourceLabel(role: string, toolName?: string) {
  if (toolName) return toolLabel(toolName);
  if (role === "user") return tr("用户消息");
  if (role === "assistant") return tr("Agent 记录");
  if (role === "toolResult") return tr("工具结果");
  return tr("交接摘要");
}

function LibraryContent({
  data,
  navigate,
  query,
}: {
  data: ContextLibraryResponse;
  navigate: (target: ContextLibraryQuery) => void;
  query?: string | undefined;
}) {
  if (data.kind === "source")
    return (
      <>
        <div className="context-library-meta">
          <strong>{sourceLabel(data.role, data.toolName)}</strong>
          <span>
            {tr("字符 {{start}}–{{end}} / {{total}}", {
              start: number(data.offset + (data.text.length ? 1 : 0)),
              end: number(data.offset + data.text.length),
              total: number(data.totalCharacters),
            })}
          </span>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded source is a keyboard-scrollable region. */}
        <pre className="context-library-source" tabIndex={0}>
          {data.text}
        </pre>
        <details className="context-library-provenance">
          <summary>{tr("来源信息")}</summary>
          <dl>
            <dt>{tr("引用")}</dt>
            <dd>{data.ref}</dd>
            <dt>{tr("内容哈希")}</dt>
            <dd>{data.hash}</dd>
          </dl>
        </details>
      </>
    );
  if (data.kind === "directory")
    return (
      <>
        {!data.archives.length && (
          <p className="context-library-note">{tr("暂无资料，或没有匹配的记录。")}</p>
        )}
        <ul className="context-library-list">
          {data.archives.map((entry) => (
            <li key={entry.ref}>
              <button
                type="button"
                className="context-library-entry"
                onClick={() => navigate({ ref: entry.ref, ...(query ? { query } : {}) })}
              >
                <span className="context-library-meta">
                  <strong>{tr("记录 {{version}}", { version: entry.version })}</strong>
                  <span>{tr("{{count}} 条来源", { count: entry.sourceCount })}</span>
                  <time dateTime={entry.createdAt}>{date(entry.createdAt)}</time>
                </span>
                <span className="context-library-excerpt">{entry.excerpt}</span>
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <>
      <div className="context-library-meta">
        <strong>{tr("记录 {{version}}", { version: data.version })}</strong>
        <time dateTime={data.createdAt}>{date(data.createdAt)}</time>
      </div>
      <p className="context-library-note">{tr("摘要由模型生成，可查看原始记录核实。")}</p>
      <p className="context-library-overview">{data.summary}</p>
      {data.summaryTruncated && (
        <button type="button" onClick={() => navigate({ ref: data.summaryRef })}>
          {tr("阅读完整摘要")}
        </button>
      )}
      <h4>{tr("原始记录")}</h4>
      {!data.sources.length && <p className="context-library-note">{tr("没有匹配的来源。")}</p>}
      <ul className="context-library-list">
        {data.sources.map((entry) => (
          <li key={entry.ref}>
            <button
              type="button"
              className="context-library-entry"
              onClick={() =>
                navigate({
                  ref: entry.ref,
                  ...(entry.matchOffset ? { offset: entry.matchOffset } : {}),
                })
              }
            >
              <span className="context-library-meta">
                <strong>{sourceLabel(entry.role, entry.toolName)}</strong>
                <span>{tr("{{count}} 字符", { count: entry.characters })}</span>
              </span>
              <span className="context-library-excerpt">{entry.excerpt}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function LibraryBrowser({ api, conversationId }: { api: ApiClient; conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const library = useContextLibrary(api, conversationId, open);
  const { data, target, loading, error } = library;
  useEffect(() => setQuery(target.query ?? ""), [target.query]);
  return (
    <details
      className="agent-settings-disclosure context-library"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <IconBookmark size={14} />
        {tr("工作资料")}
      </summary>
      {open && (
        <section
          className="context-library-body"
          aria-label={tr("工作资料浏览")}
          aria-busy={loading}
        >
          <div className="context-library-toolbar">
            {library.canGoBack && (
              <button
                type="button"
                onClick={library.back}
                aria-label={tr("返回上一层")}
                title={tr("返回上一层")}
              >
                <IconChevronLeft size={14} />
              </button>
            )}
            <span>
              {data?.kind === "source"
                ? tr("原始记录")
                : target.ref
                  ? tr("概览与来源")
                  : tr("资料目录")}
            </span>
            <button
              type="button"
              className="context-library-refresh"
              onClick={library.refresh}
              disabled={loading}
              aria-label={tr("刷新工作资料")}
              title={tr("刷新工作资料")}
            >
              <IconRefresh size={14} />
            </button>
          </div>
          {data && data.kind !== "source" && (
            <form
              className="context-library-search"
              onSubmit={(event) => {
                event.preventDefault();
                library.navigate({
                  ...(target.ref ? { ref: target.ref } : {}),
                  ...(query.trim() ? { query: query.trim() } : {}),
                });
              }}
            >
              <input
                type="search"
                value={query}
                maxLength={200}
                aria-label={tr("搜索工作资料")}
                placeholder={tr("搜索摘要和原始记录")}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <button type="submit" disabled={loading}>
                {tr("搜索")}
              </button>
            </form>
          )}
          {loading && (
            <p role="status" className="context-library-note">
              {tr("正在加载工作资料…")}
            </p>
          )}
          {error && (
            <div role="alert">
              <p>{error}</p>
              <button type="button" onClick={library.refresh}>
                {tr("重试")}
              </button>
            </div>
          )}
          {data && <LibraryContent data={data} query={target.query} navigate={library.navigate} />}
          {data?.nextOffset !== null && data?.nextOffset !== undefined && (
            <button
              type="button"
              className="context-library-next"
              onClick={() => library.navigate({ ...target, offset: data.nextOffset! })}
            >
              {data.kind === "source" ? tr("继续阅读") : tr("下一页")}
            </button>
          )}
        </section>
      )}
    </details>
  );
}

export function ContextLibrary({ conversationId }: { conversationId?: string | null | undefined }) {
  useTranslation();
  const { api, bindingId } = useSessionConnection();
  return conversationId ? (
    <LibraryBrowser
      key={`${bindingId}:${conversationId}`}
      api={api}
      conversationId={conversationId}
    />
  ) : null;
}
