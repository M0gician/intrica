import {
  boundedToolText,
  isRecord,
  parsedToolOutput,
  readableToolOutput,
  toolDiagnosticText,
  toolInputText,
  toolLabel,
  toolOutcomeLabel,
} from "../features/conversations/tool-display";
import { tr } from "../i18n";
import { Button } from "../ui/button";
import { DeferredDetails } from "./DeferredDetails";
import { ExecutionTarget } from "./ExecutionTarget";
import { ToolResultSummary } from "./ToolResultSummary";
import "./tool-call-details.css";
import { useSessionConnection } from "../api/connection";

export type ToolNavigation = {
  onSelectNode?: ((id: string) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  nodeName?: ((id: string) => string) | undefined;
};
export function ToolCallDetails({
  data,
  ...navigation
}: { data: Record<string, unknown> } & ToolNavigation) {
  return (
    <DeferredDetails
      className="tool-call-details"
      summary={
        <>
          <span className="tool-call-name">
            {toolLabel(typeof data.name === "string" ? data.name : "")}
          </span>
          <span className="tool-call-state">{toolOutcomeLabel(data)}</span>
        </>
      }
    >
      {() => <ToolCallBody data={data} {...navigation} />}
    </DeferredDetails>
  );
}
export function ToolCallBody({
  data,
  onSelectNode,
  onOpenFile,
  nodeName,
}: { data: Record<string, unknown> } & ToolNavigation) {
  const { assetUrl, serverId } = useSessionConnection();
  const output = parsedToolOutput(data.result);
  const args = isRecord(data.args) ? data.args : undefined;
  const target = isRecord(args?.target) ? args.target : undefined;
  const scope = isRecord(args?.scope) ? args.scope : undefined;
  const inputPath = target?.path ?? scope?.path ?? args?.path;
  const text = readableToolOutput(data),
    input = toolInputText(data);
  const path =
    typeof data.targetPath === "string"
      ? data.targetPath
      : typeof inputPath === "string"
        ? inputPath
        : typeof data.workingDirectory === "string"
          ? data.workingDirectory
          : typeof args?.cwd === "string"
            ? args.cwd
            : undefined;
  const nodeId = [
    "read",
    "update_node",
    "create_artifact",
    "hire_agent",
    "configure_agent",
  ].includes(typeof data.name === "string" ? data.name : "")
    ? typeof output?.id === "string"
      ? output.id
      : typeof output?.nodeId === "string"
        ? output.nodeId
        : typeof target?.nodeId === "string"
          ? target.nodeId
          : typeof args?.nodeId === "string"
            ? args.nodeId
            : undefined
    : undefined;
  const matches = Array.isArray(output?.matches)
    ? output.matches.filter(
        (match): match is { path: string; lineNumber: number; text: string } =>
          isRecord(match) &&
          typeof match.path === "string" &&
          typeof match.lineNumber === "number" &&
          typeof match.text === "string",
      )
    : null;
  const fileLink = (value: string, label = value, verification = false) =>
    onOpenFile && value.startsWith("/") ? (
      <Button
        type="button"
        className="tool-node-link"
        aria-label={verification ? tr("打开文件核实") : undefined}
        onClick={() => onOpenFile(value)}
      >
        {label}
      </Button>
    ) : (
      <span>{label}</span>
    );
  const name = (id: string) => nodeName?.(id) || id;
  const result = data.result as
    | {
        content?: Array<{
          type: string;
          data?: string;
          mimeType?: string;
          intricaMedia?: { id: string; serverId?: string };
        }>;
      }
    | undefined;
  const images = Array.isArray(result?.content)
    ? result.content.filter(
        (part) =>
          isRecord(part) &&
          (!part.intricaMedia?.serverId || part.intricaMedia.serverId === serverId) &&
          part.type === "image" &&
          (Boolean(part.data) || Boolean(part.intricaMedia?.id)) &&
          typeof part.mimeType === "string" &&
          /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType),
      )
    : [];
  return (
    <div className="tool-call-body">
      {path && (
        <p className="tool-target-path">
          <code>
            {path === data.targetPath || path === inputPath
              ? fileLink(path, path, data.status === "unknown")
              : path}
          </code>
        </p>
      )}
      {data.approvalStatus === "expired" && (
        <p>{tr("申请已过期，此次操作未执行。已保存的产物仍保留。")}</p>
      )}
      <ToolResultSummary data={data} nodeName={nodeName} onSelectNode={onSelectNode} />
      {input && (
        <>
          <h3 className="tool-call-heading">{tr("输入")}</h3>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tool text must be reachable for keyboard reading. */}
          <pre tabIndex={0}>{boundedToolText(input)}</pre>
        </>
      )}
      {nodeId &&
        (onSelectNode ? (
          <Button type="button" className="tool-node-link" onClick={() => onSelectNode(nodeId)}>
            {tr("查看节点：{{v0}}", {
              v0: typeof output?.title === "string" ? output.title : name(nodeId),
            })}
          </Button>
        ) : (
          <p>{typeof output?.title === "string" ? output.title : name(nodeId)}</p>
        ))}
      {typeof output?.page === "number" && (
        <p>
          {tr("第 {{page}} / {{count}} 页", { page: output.page, count: output.pageCount ?? "?" })}
        </p>
      )}
      {text && (
        <>
          <h3 className="tool-call-heading">{tr("输出")}</h3>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tool text must be reachable for keyboard reading. */}
          <pre tabIndex={0}>{boundedToolText(text)}</pre>
        </>
      )}
      {output &&
        !text &&
        ((data.name === "read_canvas" && !Array.isArray(output.nodes)) ||
          (data.name === "list_access_requests" && !Array.isArray(output.requests)) ||
          (data.name === "read" && target?.kind === "node" && typeof output.content !== "string") ||
          (data.name === "review_access_request" && typeof output.status !== "string")) && (
          <p className="tool-summary-note">{tr("结果格式无法识别，请查看原始结果。")}</p>
        )}
      {typeof output?.delivered === "number" && (
        <p>{tr("已投递：{{v0}}", { v0: output.delivered })}</p>
      )}
      {matches && (
        <ul className="tool-search-results">
          {matches.slice(0, 200).map((match) => (
            <li key={`${match.path}:${match.lineNumber}`}>
              {fileLink(match.path, `${match.path}:${match.lineNumber}`)}
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Long search lines must be reachable for keyboard reading. */}
              <pre tabIndex={0}>{boundedToolText(match.text, 2000)}</pre>
            </li>
          ))}
        </ul>
      )}
      {output?.truncated === true && <p>{tr("结果未完整，请缩小范围或继续分页读取。")}</p>}
      {output?.sharing !== null &&
        typeof output?.sharing === "object" &&
        "status" in output.sharing && (
          <p>
            {tr("共享状态：{{v0}}", {
              v0:
                (
                  {
                    complete: tr("已共享"),
                    partial: tr("部分共享"),
                    blocked: tr("共享受阻"),
                    private: tr("主动保密"),
                  } as Record<string, string>
                )[String(output.sharing.status)] ?? String(output.sharing.status),
            })}
          </p>
        )}
      {Array.isArray(output?.sharedWith) && output.sharedWith.length > 0 && (
        <p>
          {tr("接收者：{{v0}}", {
            v0: output.sharedWith
              .filter((id): id is string => typeof id === "string")
              .map(name)
              .join(" · "),
          })}
        </p>
      )}
      {images.map((p) => (
        <img
          className="tool-result-image"
          key={p.intricaMedia?.id ?? p.data}
          alt={tr("工具返回的图片")}
          src={
            p.intricaMedia?.id
              ? assetUrl(`/api/v2/media/${encodeURIComponent(p.intricaMedia.id)}`)
              : `data:${p.mimeType};base64,${p.data}`
          }
        />
      ))}
      <DeferredDetails summary={tr("原始参数、结果与内部标识")}>
        {() => (
          <>
            <ExecutionTarget />
            {typeof data.updatedAt === "string" && (
              <small>
                {tr("状态更新：{{v0}}", { v0: new Date(data.updatedAt).toLocaleString() })}
              </small>
            )}
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable diagnostics must be reachable for keyboard reading. */}
            <pre tabIndex={0}>{toolDiagnosticText(data)}</pre>
          </>
        )}
      </DeferredDetails>
    </div>
  );
}
