import type {
  ContextSnapshot,
  Node,
  Operation,
  OperationIntentRequest,
  SnapshotResponse,
} from "@intrica/contracts";
import {
  CONTEXT_BUDGET_CHARS,
  generationPdfNodeIds,
  MAX_MODEL_ITEMS,
  MAX_MODEL_TEXT_CHARS,
  MAX_MODEL_TITLE_CHARS,
} from "@intrica/contracts";
import { createRunner } from "../../adapters/model/index.js";
import type { FrozenModel, ModelRegistry } from "../../adapters/model/registry.js";
import {
  canvasEvent,
  DomainError,
  digest,
  id,
  type Sql,
} from "../../adapters/postgres/database.js";
import type { PromptLanguage } from "../../prompt-language.js";
import { OWNER } from "../access/policy.js";
import type { Run, RunStore } from "../execution/store.js";
import type { ExecutionContext } from "../execution/worker.js";
import type { GraphCommands } from "../graph/commands.js";
import { containerChildRects, findFreeColumn, selectionBounds } from "../graph/placement.js";
import { edgeView, type GraphQueries } from "../graph/queries.js";

type Item = { id: string; title: string; text: string };
type Input = {
  intent: OperationIntentRequest;
  language: PromptLanguage;
  context: ContextSnapshot;
  selection: Node[];
  bounds: NonNullable<ReturnType<typeof selectionBounds>>;
  model: FrozenModel;
  replace?: { proposalId: string; itemId: string };
};
type Proposal = {
  id: string;
  run_id: string;
  attempt_id: string;
  canvas_id: string;
  items: Item[];
  decisions: Record<string, { state: string; commandId?: string; nodeId?: string }>;
  created_at: Date;
};

export class GenerationService {
  readonly queries: GraphQueries;
  constructor(
    readonly graph: GraphCommands,
    readonly runs: RunStore,
    readonly models: ModelRegistry,
    readonly resolveAsset: (id: string) => Promise<{ data: Buffer; mime: string } | null>,
  ) {
    this.queries = graph.queries;
  }
  async context(
    intent: OperationIntentRequest,
    sql?: Sql,
    excludeAttemptId?: string,
    preview = false,
  ) {
    const collect = async (tx: Sql) => {
      const canvasId = await this.queries.canvasId(intent.scopeId, tx);
      if (!intent.selection.length || new Set(intent.selection).size !== intent.selection.length)
        throw new DomainError("VALIDATION", "请选择不同的来源元素");
      if (intent.type === "compress" && intent.selection.length < 2)
        throw new DomainError("VALIDATION", "收束需要至少两个元素");
      const scope = await this.queries.node(intent.scopeId, tx);
      const selected = await Promise.all(intent.selection.map((n) => this.queries.node(n, tx)));
      if (selected.some((n) => n.parentId !== intent.scopeId))
        throw new DomainError("SCOPE_MISMATCH", "请选择同一层级的元素");
      const edges = (
        await tx.query(
          "select * from edges where canvas_id=$1 and (from_id=any($2::text[]) or to_id=any($2::text[])) and ($3::text is null or source_attempt_id is distinct from $3) order by id limit 200",
          [canvasId, intent.selection, excludeAttemptId ?? null],
        )
      ).rows.map(edgeView);
      const neighbors = [...new Set(edges.flatMap((e) => [e.from, e.to]))].filter(
        (n) => !intent.selection.includes(n),
      );
      const list = [...selected];
      const omitted: string[] = [];
      for (const nodeId of intent.includeDescendants) {
        if (!intent.selection.includes(nodeId))
          throw new DomainError("VALIDATION", "展开后代必须属于选区");
        const descendants = await this.queries.descendantIds(nodeId, tx);
        list.push(
          ...(await Promise.all(descendants.slice(0, 200).map((id) => this.queries.node(id, tx)))),
        );
        omitted.push(...descendants.slice(200));
      }
      if (intent.includeConnected)
        for (const n of neighbors) list.push(await this.queries.node(n, tx));
      const unique = [...new Map(list.map((n) => [n.id, n])).values()];
      // Generation has no document-reading tool loop. Never present a PDF's
      // filename or annotations as if they were its document contents.
      const blockedPdfNodeIds = generationPdfNodeIds([scope, ...unique]);
      if (!preview && blockedPdfNodeIds.length)
        throw new DomainError(
          "VALIDATION",
          "画布生成暂不支持 PDF 上下文；请让 Agent 使用 read 的 node 目标 按页阅读 PDF，再根据阅读结果生成内容。",
        );
      let chars = 0;
      const kept: Node[] = [];
      for (const n of unique) {
        const size = (n.title?.length ?? 0) + (n.text?.length ?? 0) + (n.summary?.length ?? 0);
        if (chars + size > CONTEXT_BUDGET_CHARS) {
          if (intent.selection.includes(n.id))
            throw new DomainError("CONTEXT_BUDGET", "选区正文超过上下文预算，请缩小选区");
          omitted.push(n.id);
        } else {
          chars += size;
          kept.push(n);
        }
      }
      const snapshot: ContextSnapshot = {
        snapshotVersion: 2,
        scope: {
          id: scope.id,
          kind: scope.kind,
          title: scope.title ?? "",
          ...(scope.summary ? { summary: scope.summary } : {}),
        },
        selection: intent.selection,
        contextOnlyNodeIds: kept.filter((n) => !intent.selection.includes(n.id)).map((n) => n.id),
        nodes: kept.map((n) => ({
          id: n.id,
          kind: n.kind,
          revision: n.revision,
          title: n.title ?? "",
          text: n.agent?.persona ?? n.text ?? "",
          ...(n.summary ? { summary: n.summary } : {}),
          ...(n.assetId ? { assetId: n.assetId, assetVersion: 1 } : {}),
          containerPath: [canvasId, n.parentId ?? canvasId],
        })),
        edges: edges.filter(
          (e) => kept.some((n) => n.id === e.from) && kept.some((n) => n.id === e.to),
        ),
        includeDescendants: intent.includeDescendants,
        omittedNodeIds: omitted,
        instruction: intent.instruction,
      };
      return {
        canvasId,
        selected,
        scope,
        snapshot,
        neighbors,
        chars,
        bounds: selectionBounds(selected)!,
        blockedPdfNodeIds,
      };
    };
    return sql ? collect(sql) : this.graph.db.transaction(collect, true);
  }
  async preview(intent: OperationIntentRequest) {
    const c = await this.context(intent, undefined, undefined, true);
    const model = await this.models.resolve();
    return {
      preview: {
        blockedPdfNodeIds: c.blockedPdfNodeIds,
        draft: c.snapshot,
        neighborIds: c.neighbors,
        descendantCounts: Object.fromEntries(c.selected.map((n) => [n.id, n.childOrder.length])),
        estimatedChars: c.chars,
        budgetChars: CONTEXT_BUDGET_CHARS,
        visionRequired: c.selected.some((n) => n.kind === "image"),
        visionSupported: createRunner(model).supportsVision,
      },
    };
  }
  async create(
    req: OperationIntentRequest & { idempotencyKey: string },
    replace?: Input["replace"],
    language: PromptLanguage = "en",
  ) {
    const canvasId = await this.queries.canvasId(req.scopeId);
    const model = await this.models.capture();
    const runId = `run-${digest([canvasId, req.idempotencyKey]).slice(0, 32)}`;
    await this.graph.db.canvas(canvasId, async (tx) => {
      const prior = (await tx.query("select frozen_input from runs where id=$1", [runId])).rows[0];
      const { idempotencyKey: _idempotencyKey, ...intent } = req;
      if (prior) {
        if (digest(prior.frozen_input.intent) !== digest(intent))
          throw new DomainError("IDEMPOTENCY_CONFLICT", "请求键已用于不同生成任务");
        return;
      }
      const c = await this.context(intent, tx);
      if (
        c.snapshot.nodes.some((n) => n.kind === "image") &&
        !createRunner(await this.models.materialize(model)).supportsVision
      )
        throw new DomainError("VISION_UNSUPPORTED", "当前模型不支持图片");
      const frozen: Input = {
        intent,
        language,
        context: c.snapshot,
        selection: c.selected,
        bounds: c.bounds,
        model,
        ...(replace ? { replace } : {}),
      };
      await this.runs.enqueue(tx, {
        id: runId,
        canvasId,
        subjectId: runId,
        kind: "generation",
        frozen,
      });
    });
    return { operation: (await this.view(runId)).operation, queuePosition: null };
  }
  async execute(ctx: ExecutionContext) {
    const input = ctx.run.frozen_input as Input;
    const config = await this.models.materialize(input.model);
    const runner = createRunner(config);
    const items: Item[] = [];
    let title = "",
      text = "";
    for await (const event of runner.run(
      {
        operationId: ctx.run.id,
        language: input.language,
        type: input.intent.type,
        contextSnapshot: input.context,
        placementMode: placement(input.intent),
        instruction: input.intent.instruction,
        resolveAsset: (assetId) => this.resolveAsset(assetId),
      },
      ctx.signal,
    )) {
      ctx.signal.throwIfAborted();
      ctx.progress();
      if (event.type === "error") throw new DomainError("MODEL_ERROR", event.message);
      if (event.type === "item.start") {
        if (items.length >= MAX_MODEL_ITEMS || items[event.itemIndex])
          throw new DomainError("VALIDATION", "模型条目无效");
        items[event.itemIndex] = {
          id: `candidate-${ctx.run.attemptId}-${event.itemIndex}`,
          title: event.title,
          text: "",
        };
      }
      if (event.type === "item.segment") {
        const item = items[event.itemIndex];
        if (!item) throw new DomainError("VALIDATION", "模型条目缺少标题");
        item.text += event.text;
      }
      if (event.type === "summary.segment") {
        if (event.field === "title") title += event.text;
        else text += event.text;
      }
      await ctx.store.event(ctx.run, "generation.progress", { items: items.length });
    }
    ctx.signal.throwIfAborted();
    if (input.intent.type === "compress")
      items.push({ id: `candidate-${ctx.run.attemptId}-0`, title, text });
    if (
      !items.length ||
      items.some(
        (n) =>
          !n?.title.trim() ||
          !n.text.trim() ||
          n.title.length > MAX_MODEL_TITLE_CHARS ||
          n.text.length > MAX_MODEL_TEXT_CHARS,
      )
    )
      throw new DomainError("VALIDATION", "模型没有返回完整有效的结果");
    await ctx.store.finish(ctx.run, "succeeded", async (tx) => {
      const proposalId = id("proposal");
      await tx.query(
        "insert into proposals(id,canvas_id,run_id,attempt_id,items) values($1,$2,$3,$4,$5)",
        [
          proposalId,
          ctx.run.canvas_id,
          ctx.run.id,
          ctx.run.attemptId,
          JSON.stringify(input.replace ? items.slice(0, 1) : items),
        ],
      );
      if (input.replace)
        await tx.query(
          "update proposals set decisions=jsonb_set(decisions,array[$2],$3::jsonb),version=version+1 where id=$1 and not(decisions ? $2)",
          [input.replace.proposalId, input.replace.itemId, JSON.stringify({ state: "superseded" })],
        );
      await canvasEvent(tx, ctx.run.canvas_id, "proposal.changed", {
        runId: ctx.run.id,
        id: proposalId,
      });
    });
  }
  async view(runId: string, sql: Sql = this.graph.db.pool) {
    const run = await this.runs.get(runId, sql);
    if (run.kind !== "generation") throw new DomainError("NOT_FOUND", "生成任务不存在");
    const proposal = (
      await sql.query("select * from proposals where run_id=$1 order by created_at desc limit 1", [
        runId,
      ])
    ).rows[0] as Proposal | undefined;
    const receipt = (
      await sql.query(
        "select id,undone from commands where canvas_id=$1 and kind='operation.commit' and response->>'runId'=$2 order by created_at desc,id desc limit 1",
        [run.canvas_id, runId],
      )
    ).rows[0];
    return project(run, proposal, receipt);
  }
  async snapshot(canvasId: string, sql: Sql = this.graph.db.pool) {
    const rows = (
      await sql.query(
        `select r.* from runs r where r.canvas_id=$1 and r.kind='generation' and (
      r.state in ('queued','running','waiting') or exists(select 1 from proposals p where p.run_id=r.id and jsonb_array_length(p.items)>(select count(*) from jsonb_object_keys(p.decisions)))
      or r.id in (select id from runs where canvas_id=$1 and kind='generation' order by created_at desc limit 20)) order by r.created_at`,
        [canvasId],
      )
    ).rows as Run[];
    const ps = (
      await sql.query("select * from proposals where run_id=any($1::text[])", [
        rows.map((r) => r.id),
      ])
    ).rows as Proposal[];
    const receipts = (
      await sql.query(
        "select distinct on(response->>'runId') response->>'runId' as run_id,id,undone from commands where canvas_id=$1 and kind='operation.commit' order by response->>'runId',created_at desc,id desc",
        [canvasId],
      )
    ).rows;
    const byRun = new Map(ps.map((p) => [p.run_id, p]));
    const byReceipt = new Map(receipts.map((r) => [r.run_id, r]));
    const views = rows.map((r) => project(r, byRun.get(r.id), byReceipt.get(r.id)));
    return {
      operations: views.map((v) => v.operation),
      candidateNodes: views.flatMap((v) => v.candidateNodes),
      candidateContainers: views.flatMap((v) => v.candidateContainers),
    };
  }
  async accept(runId: string, req: { idempotencyKey: string; candidateIds?: string[] }) {
    const run = await this.runs.get(runId);
    const input = run.frozen_input as Input;
    const result = await this.graph.command(
      run.canvas_id,
      req.idempotencyKey,
      "operation.commit",
      { runId, ...req },
      OWNER,
      async (m) => {
        const p = (await m.tx.query("select * from proposals where run_id=$1 for update", [runId]))
          .rows[0] as Proposal | undefined;
        if (!p) throw new DomainError("INVALID_STATE", "任务尚未生成完整提案");
        const pending = p.items.filter((item) => !p.decisions[item.id]);
        const selected = req.candidateIds ?? pending.map((n) => n.id);
        if (
          !selected.length ||
          new Set(selected).size !== selected.length ||
          selected.some((n) => !pending.some((i) => i.id === n))
        )
          throw new DomainError("INVALID_STATE", "所选候选已处理");
        if (input.intent.type !== "expand" && selected.length !== pending.length)
          throw new DomainError("VALIDATION", "深入和收束需要整体接受");
        let currentContext: Awaited<ReturnType<GenerationService["context"]>>;
        try {
          currentContext = await this.context(input.intent, m.tx, p.attempt_id);
        } catch {
          throw new DomainError("ACCEPT_CONFLICT", "来源内容或所属层级已变化，请重新生成");
        }
        if (digest(currentContext.snapshot) !== digest(input.context))
          throw new DomainError("ACCEPT_CONFLICT", "来源内容、关系或所选后代已变化，请重新生成");
        const bounds = currentContext.bounds;
        const scope = input.intent.scopeId;
        const mode = placement(input.intent);
        let parent = mode === "inside_selected" ? input.intent.selection[0]! : scope;
        let group: string | undefined;
        if (mode === "inside_result_container" || mode === "compress_container") {
          const siblings = await this.queries.children(scope, m.tx);
          const position = findFreeColumn({
            existing: siblings.map((n) => n.position),
            anchor: bounds,
            count: 1,
            size: { width: 280, height: 200 },
          })[0]!;
          group = await m.insert({
            id: `group-${p.id}`,
            kind: "group",
            parentId: scope,
            title: input.intent.type === "compress" ? p.items[0]!.title : "深化结果",
            summary: input.intent.type === "compress" ? p.items[0]!.text : "",
            position,
            origin: "model",
          });
          parent = group;
        }
        const outputs: string[] = [];
        if (input.intent.type === "compress") {
          for (const original of input.selection) {
            const current = await this.queries.node(original.id, m.tx);
            await m.move(
              current.id,
              parent,
              current.position.x - bounds.x + 16,
              current.position.y - bounds.y + 16,
            );
            await m.link(group!, original.id, "derived_from", p.attempt_id, original.revision);
          }
          outputs.push(group!);
        } else {
          const existing = await this.queries.children(parent, m.tx);
          const items = pending.filter((i) => selected.includes(i.id));
          const positions =
            mode === "sibling"
              ? findFreeColumn({
                  existing: existing.map((n) => n.position),
                  anchor: bounds,
                  count: items.length,
                  size: { width: 240, height: 160 },
                })
              : containerChildRects({
                  existing: existing.map((n) => n.position),
                  count: items.length,
                });
          for (const [index, item] of items.entries()) {
            const nodeId = await m.insert({
              id: `n-${item.id}`,
              kind: "text",
              parentId: parent,
              title: item.title,
              text: item.text,
              position: positions[index]!,
              origin: "model",
            });
            outputs.push(nodeId);
            for (const source of input.selection)
              await m.link(nodeId, source.id, "derived_from", p.attempt_id, source.revision);
          }
        }
        for (const [index, itemId] of selected.entries())
          p.decisions[itemId] = { state: "accepted", nodeId: outputs[index] ?? outputs[0]! };
        await m.tx.query("update proposals set decisions=$2,version=version+1 where id=$1", [
          p.id,
          JSON.stringify(p.decisions),
        ]);
        await canvasEvent(m.tx, run.canvas_id, "proposal.changed", { runId, id: p.id });
        return { runId, outputIds: outputs, proposalId: p.id, candidateIds: selected };
      },
      runId,
    );
    // The command receipt owns undo. UI receives the exact command instead of a global undo stack.
    return {
      ...result,
      operation: { ...(await this.view(runId)).operation, undoToken: result.graphOpId },
      graphRevision: result.graphRevision,
      graphOpId: result.graphOpId,
    };
  }
  async discard(runId: string, _req: { idempotencyKey: string }) {
    const run = await this.runs.get(runId);
    await this.graph.db.canvas(run.canvas_id, async (tx) => {
      const p = (await tx.query("select * from proposals where run_id=$1 for update", [runId]))
        .rows[0] as Proposal | undefined;
      if (!p) throw new DomainError("INVALID_STATE", "没有待审阅提案");
      for (const item of p.items)
        if (!p.decisions[item.id]) p.decisions[item.id] = { state: "discarded" };
      await tx.query("update proposals set decisions=$2,version=version+1 where id=$1", [
        p.id,
        JSON.stringify(p.decisions),
      ]);
      await canvasEvent(tx, run.canvas_id, "proposal.changed", { runId, id: p.id });
    });
    return { operation: (await this.view(runId)).operation, graphRevision: 0 };
  }
  async retry(runId: string, key: string, itemId?: string) {
    const run = await this.runs.get(runId);
    const input = run.frozen_input as Input;
    let replace: Input["replace"];
    if (itemId) {
      const p = (await this.graph.db.pool.query("select * from proposals where run_id=$1", [runId]))
        .rows[0] as Proposal | undefined;
      if (!p || p.decisions[itemId] || !p.items.some((i) => i.id === itemId))
        throw new DomainError("INVALID_STATE", "此候选不可重试");
      replace = { proposalId: p.id, itemId };
    }
    const result = await this.create(
      { ...input.intent, idempotencyKey: key },
      replace,
      input.language,
    );
    return { discardedOperationId: runId, operation: result.operation };
  }
}
function placement(intent: OperationIntentRequest) {
  return intent.type === "expand"
    ? "sibling"
    : intent.type === "compress"
      ? "compress_container"
      : intent.selection.length === 1
        ? "inside_selected"
        : "inside_result_container";
}
function project(run: Run, p?: Proposal, receipt?: { id: string; undone: boolean }) {
  const input = run.frozen_input as Input;
  const mode = placement(input.intent);
  const pending = p?.items.filter((i) => !p.decisions[i.id]) ?? [];
  const accepted = Object.values(p?.decisions ?? {}).filter((d) => d.state === "accepted");
  const status: Operation["status"] =
    run.state === "succeeded"
      ? pending.length
        ? "candidate"
        : accepted.length
          ? "committed"
          : "discarded"
      : run.state === "waiting"
        ? "failed"
        : run.state;
  const group =
    p && (mode === "inside_result_container" || mode === "compress_container")
      ? `group-${p.id}`
      : null;
  const parent =
    mode === "inside_selected" ? input.intent.selection[0]! : (group ?? input.intent.scopeId);
  const outputIds = pending.length
    ? pending.map((i) => i.id)
    : accepted.flatMap((d) => (d.nodeId ? [d.nodeId] : []));
  const operation: Operation = {
    canvasId: run.canvas_id,
    id: run.id,
    type: input.intent.type,
    scopeId: input.intent.scopeId,
    placementMode: mode,
    selection: input.intent.selection,
    outputParentId: mode === "compress_container" ? null : parent,
    resultContainerId: group,
    resultContainerParentId: group ? input.intent.scopeId : null,
    resultContainerState: group
      ? pending.length
        ? "reserved"
        : accepted.length
          ? "committed"
          : "tombstoned"
      : "none",
    outputIds,
    instruction: input.intent.instruction,
    status,
    undone: receipt?.undone ?? false,
    ...(receipt && !receipt.undone ? { undoToken: receipt.id } : {}),
    createdAt: new Date(run.created_at).toISOString(),
    ...(run.reason ? { reason: run.reason } : {}),
    ...(input.intent.type === "compress" && p
      ? { candidateSummary: { title: p.items[0]!.title, summary: p.items[0]!.text } }
      : {}),
  };
  const rects =
    mode === "sibling"
      ? findFreeColumn({
          existing: [],
          anchor: input.bounds,
          count: pending.length,
          size: { width: 240, height: 160 },
        })
      : containerChildRects({ existing: [], count: pending.length });
  const candidateNodes: SnapshotResponse["candidateNodes"] =
    input.intent.type === "compress"
      ? []
      : pending.map((item, i) => ({
          id: item.id,
          kind: "text",
          parentId: parent,
          position: rects[i]!,
          lifecycle: "candidate",
          operationId: run.id,
          origin: "model",
          title: item.title,
          text: item.text,
        }));
  const candidateContainers: SnapshotResponse["candidateContainers"] =
    group && pending.length
      ? [
          {
            id: group,
            kind: "group",
            parentId: input.intent.scopeId,
            position: {
              x: input.bounds.x + input.bounds.width + 24,
              y: input.bounds.y,
              width: 280,
              height: 200,
            },
            lifecycle: "candidate",
            operationId: run.id,
            projection: input.intent.type === "compress" ? "review_only" : "readonly_canvas",
            title: input.intent.type === "compress" ? p!.items[0]!.title : "深化结果",
            summary: input.intent.type === "compress" ? p!.items[0]!.text : "",
            childIds: candidateNodes.map((n) => n.id),
          },
        ]
      : [];
  return { operation, candidateNodes, candidateContainers };
}
