import type { CollaborationReceipt, Node } from "@intrica/contracts";
import type { ReactNode } from "react";
import { DeferredDetails } from "../../components/DeferredDetails";
import { MarkdownLite } from "../../components/MarkdownLite";
import { ToolCallDetails } from "../../components/ToolCallDetails";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";
import { FileReferenceView } from "../files/FileReferenceView";
import { ActivityHeader, EventTime, recipientName } from "./ActivityHeader";
import { DeliveryReceipts } from "./DeliveryReceipts";
import { isContentTruncated, recordVersion } from "./full-records";
import { InputReceipt, type Receipt } from "./InputReceipt";
import { MessageNotice } from "./MessageNotice";
import { type Activity, activityKey } from "./model";
import { ReadMore } from "./ReadMore";
export function TimelineEvent({
  event,
  nodes,
  accessCards,
  requestEvent,
  onSelectNode,
  onOpenFile,
  onExpandEvent,
}: {
  event: Activity;
  nodes: ReadonlyMap<string, Node>;
  accessCards?: Array<{ id: string; card: ReactNode; pending?: boolean }> | undefined;
  requestEvent: ReadonlyMap<string, string>;
  onSelectNode?: ((id: string) => void) | undefined;
  onOpenFile?: ((path: string) => void) | undefined;
  onExpandEvent?: ((seq: number) => Promise<void>) | undefined;
}) {
  const seq = typeof event.data.fullRecordSeq === "number" ? event.data.fullRecordSeq : event.seq;
  const load = seq > 0 && onExpandEvent ? () => onExpandEvent(seq) : undefined;
  const version = JSON.stringify([
    recordVersion(event),
    event.data.updatedAt,
    event.data.resultVersion,
  ]);
  const trackedNotice = event.kind === "message_notice" && Array.isArray(event.data.deliveries);
  return (
    <>
      <ActivityHeader event={event} nodes={nodes} />
      {event.kind === "broadcast" && (
        <DeferredDetails className="broadcast-scope" summary={tr("接收者与共享资源")}>
          {() => (
            <>
              <p>
                {((event.data.recipients as string[]) ?? [])
                  .map((id) => recipientName(event, nodes, id))
                  .join("、")}
              </p>
              <p>
                {((event.data.resourceIds as string[]) ?? [])
                  .map((id) => nodes.get(id)?.title || tr("已移除的资源"))
                  .join("、")}
              </p>
            </>
          )}
        </DeferredDetails>
      )}
      {["access", "permission_notice"].includes(event.kind) &&
      requestEvent.get(String(event.data.requestId)) === activityKey(event) &&
      accessCards?.some((c) => c.id === event.data.requestId) ? (
        accessCards.find((c) => c.id === event.data.requestId)?.card
      ) : event.kind === "permission_notice" ? (
        <p>{tr("审批状态已更新，请查看权限申请。")}</p>
      ) : event.kind === "tool" ? (
        <ToolCallDetails
          data={event.data}
          onSelectNode={onSelectNode}
          onOpenFile={onOpenFile}
          nodeName={(id) => nodes.get(id)?.title || id}
          load={isContentTruncated(event, "result") ? load : undefined}
          loadKey={version}
        />
      ) : (
        <>
          {event.data.thinking ? (
            <DeferredDetails
              summary={tr("思考")}
              load={isContentTruncated(event, "thinking") ? load : undefined}
              loadKey={version}
            >
              {() => <p>{String(event.data.thinking)}</p>}
            </DeferredDetails>
          ) : null}
          {!trackedNotice && (
            <MarkdownLite
              origin={{
                kind: "agent",
                id: String(event.data.from ?? event.data.senderId ?? event.agentId),
              }}
              text={String(
                event.data.text ??
                  event.data.reason ??
                  (event.kind === "access"
                    ? ({
                        approve: tr("权限已批准，将继续工作。"),
                        deny: tr("权限已拒绝，将按现有权限继续。"),
                        revoke: tr("授权已撤销。"),
                        escalate: tr("权限申请已交给用户。"),
                      }[String(event.data.decision)] ?? tr("权限状态已更新"))
                    : ""),
              )}
            />
          )}
          {trackedNotice && (
            <MessageNotice
              deliveryIds={(event.data.deliveries as Array<{ deliveryId: string }>).map(
                (d) => d.deliveryId,
              )}
              conversationId={event.conversationId}
            />
          )}
          {load && isContentTruncated(event, "text") && <ReadMore load={load} version={version} />}
          {Array.isArray(event.data.fileIds) &&
            event.data.fileIds.map((id) =>
              typeof id === "string" ? (
                <FileReferenceView
                  key={id}
                  origin={{ kind: "node", id }}
                  label={
                    nodes.get(id)?.resource?.snapshot?.name ??
                    nodes.get(id)?.title ??
                    tr("查看文件")
                  }
                />
              ) : null,
            )}
          {typeof event.data.memoryNodeId === "string" &&
            nodes.has(event.data.memoryNodeId) &&
            onSelectNode && (
              <Button type="button" onClick={() => onSelectNode(event.data.memoryNodeId as string)}>
                {tr("查看会话笔记")}
              </Button>
            )}
        </>
      )}
      {Array.isArray(event.data.deliveryReceipts) && (
        <DeliveryReceipts
          receipts={event.data.deliveryReceipts as CollaborationReceipt[]}
          time={<EventTime value={event.createdAt} />}
          conversationId={event.conversationId}
        />
      )}
      {event.kind === "user" && (
        <InputReceipt
          time={<EventTime value={event.createdAt} />}
          conversationId={event.conversationId}
          receipt={event.data.inputReceipt as Receipt | undefined}
        />
      )}
    </>
  );
}
