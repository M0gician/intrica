import { readJsonLines } from "@intrica/client";
import type {
  AcceptOperationResponse,
  AssetResponse,
  CanvasCommandResponse,
  CreateLinkRequest,
  CreateNodeRequest,
  CreateOperationRequest,
  DeleteLinkRequest,
  DeleteNodesGraphOpRequest,
  Edge,
  EdgeResponse,
  GraphOpResponse,
  IdempotencyBody,
  MoveGraphOpRequest,
  NodeMutationResponse,
  NodeResponse,
  OperationDecisionResponse,
  OperationResponse,
  PreviewOperationRequest,
  PreviewResponse,
  RetryOperationResponse,
  SnapshotResponse,
  UndoResponse,
  UpdateNodeRequest,
} from "@intrica/contracts";

export type { OperationDecisionResponse };

import { ApiError, createTransport, type FetchLike, newId } from "@intrica/client";

export type { FetchLike };
export { ApiError };

export function createApiClient(
  fetchImpl?: FetchLike,
  options: {
    baseUrl?: string;
    token?: string;
    authProvider?: () => string | undefined | Promise<string | undefined>;
    transport?: import("@intrica/client").Transport;
  } = {},
) {
  const connection = options.transport ?? createTransport(options, fetchImpl);
  const requestFetch = connection.fetch;
  const request = connection.request;
  const url = (path: string) => path;
  const requestHeaders = async () => ({});
  const jsonRequest = connection.json;

  return {
    transport: connection,
    async agentChat(
      body: {
        message: string;
        sessionId: string;
        resumeRunId?: string;
        selection: string[];
        scopeId: string;
        model?: import("@intrica/contracts").ModelSelection | null;
      },
      onEvent: (event: any) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const response = await requestFetch(url("/api/v2/agent/chat"), {
        method: "POST",
        headers: { ...(await requestHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
        credentials: "include",
      });
      await readJsonLines(response, onEvent);
    },
    retryCandidate(opId: string, candidateId: string) {
      return jsonRequest(
        "POST",
        `/api/v2/operations/${encodeURIComponent(opId)}/candidates/${encodeURIComponent(candidateId)}/retry`,
        { idempotencyKey: newId("request") },
      );
    },
    deleteCanvas(id: string) {
      return jsonRequest<CanvasCommandResponse>(
        "DELETE",
        `/api/v2/canvases/${encodeURIComponent(id)}`,
        {
          idempotencyKey: newId("request"),
        },
      );
    },
    renameCanvas(id: string, title: string, expectedTitle: string) {
      return jsonRequest<CanvasCommandResponse>(
        "PATCH",
        `/api/v2/canvases/${encodeURIComponent(id)}`,
        {
          title,
          expectedTitle,
          idempotencyKey: newId("request"),
        },
      );
    },
    createCanvas(title: string) {
      return jsonRequest<NodeResponse>("POST", "/api/v2/canvases", {
        title,
        idempotencyKey: newId("request"),
      });
    },
    getSnapshot(canvasId?: string): Promise<SnapshotResponse> {
      return request<SnapshotResponse>(
        `/api/v2/bootstrap${canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : ""}`,
      );
    },
    createNode(body: CreateNodeRequest): Promise<NodeMutationResponse> {
      return jsonRequest<NodeMutationResponse>("POST", "/api/v2/nodes", body);
    },
    updateNode(nodeId: string, body: UpdateNodeRequest): Promise<NodeMutationResponse> {
      return jsonRequest<NodeMutationResponse>(
        "PATCH",
        `/api/v2/nodes/${encodeURIComponent(nodeId)}`,
        body,
      );
    },
    async createLinks(body: { fromIds: string[]; toId: string; idempotencyKey: string }) {
      return jsonRequest<GraphOpResponse & { edges: Edge[] }>("POST", "/api/v2/links/batch", body);
    },
    async uploadAsset(file: Blob, idempotencyKey: string): Promise<AssetResponse> {
      const form = new FormData();
      form.append("file", file);
      form.append("idempotencyKey", idempotencyKey);
      return request<AssetResponse>("/api/v2/assets", { method: "POST", body: form });
    },
    submitMove(body: MoveGraphOpRequest): Promise<GraphOpResponse> {
      return jsonRequest<GraphOpResponse>("POST", "/api/v2/graph-ops", body);
    },
    copyNodes(body: { nodeIds: string[]; idempotencyKey: string }) {
      return jsonRequest<GraphOpResponse & { nodeIds: string[] }>(
        "POST",
        "/api/v2/graph-ops/copy",
        body,
      );
    },
    deleteNodes(body: DeleteNodesGraphOpRequest): Promise<GraphOpResponse> {
      return jsonRequest<GraphOpResponse>("POST", "/api/v2/graph-ops", body);
    },
    createLink(body: CreateLinkRequest): Promise<EdgeResponse> {
      return jsonRequest<EdgeResponse>("POST", "/api/v2/links", body);
    },
    deleteLink(edgeId: string, body: DeleteLinkRequest): Promise<GraphOpResponse> {
      return jsonRequest<GraphOpResponse>(
        "DELETE",
        `/api/v2/links/${encodeURIComponent(edgeId)}`,
        body,
      );
    },
    previewOperation(body: PreviewOperationRequest): Promise<PreviewResponse> {
      return jsonRequest<PreviewResponse>("POST", "/api/v2/operations/preview", body);
    },
    createOperation(body: CreateOperationRequest): Promise<OperationResponse> {
      return jsonRequest<OperationResponse>("POST", "/api/v2/operations", body);
    },
    acceptOperation(
      opId: string,
      body: IdempotencyBody & { candidateIds?: string[] },
    ): Promise<AcceptOperationResponse> {
      return jsonRequest<AcceptOperationResponse>(
        "POST",
        `/api/v2/operations/${encodeURIComponent(opId)}/accept`,
        body,
      );
    },
    discardOperation(opId: string, body: IdempotencyBody): Promise<OperationDecisionResponse> {
      return jsonRequest<OperationDecisionResponse>(
        "POST",
        `/api/v2/operations/${encodeURIComponent(opId)}/discard`,
        body,
      );
    },
    cancelOperation(opId: string, body: IdempotencyBody): Promise<OperationDecisionResponse> {
      return jsonRequest<OperationDecisionResponse>(
        "POST",
        `/api/v2/operations/${encodeURIComponent(opId)}/cancel`,
        body,
      );
    },
    retryOperation(opId: string, body: IdempotencyBody): Promise<RetryOperationResponse> {
      return jsonRequest<RetryOperationResponse>(
        "POST",
        `/api/v2/operations/${encodeURIComponent(opId)}/retry`,
        body,
      );
    },
    undoCommand(commandId: string): Promise<UndoResponse> {
      return jsonRequest<UndoResponse>(
        "POST",
        `/api/v2/graph-ops/${encodeURIComponent(commandId)}/undo`,
      );
    },
    getNode(nodeId: string): Promise<NodeResponse> {
      return request<NodeResponse>(`/api/v2/nodes/${encodeURIComponent(nodeId)}/content`);
    },
    getOperation(opId: string) {
      return request<
        OperationResponse & Pick<SnapshotResponse, "candidateNodes" | "candidateContainers">
      >(`/api/v2/operations/${encodeURIComponent(opId)}`);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const newIdempotencyKey = newId;
