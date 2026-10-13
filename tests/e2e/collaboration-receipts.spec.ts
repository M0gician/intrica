import { randomUUID } from "node:crypto";
import type { Node } from "@intrica/contracts";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

// Seed durable inbox facts in the isolated browser database. UI, status API, priority action
// and live invalidation remain real; input consumption is the controlled event in this test.
test("collaboration receipts and priority survive refresh, and pause is persistent", async ({
  page,
  request,
}, info) => {
  const key = () => randomUUID();
  const board = (
    await (
      await request.post(`${API_URL}/api/v2/canvases`, {
        data: { title: `Receipts ${key()}`, idempotencyKey: key() },
      })
    ).json()
  ).node as Node;
  const create = async (x: number) =>
    (
      await (
        await request.post(`${API_URL}/api/v2/nodes`, {
          data: {
            kind: "agent",
            parentId: board.id,
            position: { x, y: 140, width: 220, height: 300 },
            idempotencyKey: key(),
          },
        })
      ).json()
    ).node as Node;
  const sender = await create(80),
    recipient = await create(450);
  expect(sender.agent!.enabled).toBe(true);
  const db = new pg.Client({
    connectionString: DATABASE_URL,
    options: "-c search_path=intrica,public",
  });
  await db.connect();
  const deliveryId = `delivery-${key()}`,
    sourceId = `source-${key()}`,
    inboxId = `inbox-${key()}`;
  const senderRun = `run-${key()}`,
    recipientRun = `run-${key()}`;
  try {
    const cs = (
      await db.query("select id,agent_id from conversations where agent_id=any($1::text[])", [
        [sender.id, recipient.id],
      ])
    ).rows;
    const source = cs.find((c) => c.agent_id === sender.id).id,
      target = cs.find((c) => c.agent_id === recipient.id).id;
    await db.query("BEGIN");
    for (const [run, subject, state, reason] of [
      [senderRun, source, "succeeded", null],
      [recipientRun, target, "waiting", "turn_limit"],
    ])
      await db.query(
        "insert into runs(id,canvas_id,subject_id,kind,state,reason,frozen_input,cause_id) values($1,$2,$3,'conversation',$4,$5,'{}',$1)",
        [run, board.id, subject, state, reason],
      );
    const body = {
      text: "请查看这条协作消息",
      senderId: sender.id,
      senderName: sender.title,
      recipientNames: { [recipient.id]: recipient.title },
    };
    await db.query(
      "insert into messages(conversation_id,seq,client_message_id,role,content,run_id) values($1,1,$2,'message',$3,$4)",
      [source, sourceId, JSON.stringify({ ...body, recipients: [recipient.id] }), senderRun],
    );
    await db.query(
      "insert into messages(conversation_id,seq,client_message_id,role,content,run_id) values($1,1,$2,'message',$3,$4)",
      [
        target,
        inboxId,
        JSON.stringify({ ...body, from: sender.id, deliveryId, causeId: senderRun }),
        recipientRun,
      ],
    );
    await db.query("update conversations set message_seq=1 where id=any($1::text[])", [
      [source, target],
    ]);
    await db.query(
      `insert into message_deliveries(id,canvas_id,sender_conversation_id,recipient_conversation_id,
      sender_agent_id,recipient_agent_id,source_message_id,inbox_message_id,cause_id,deadline_at,unread_deadline_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour',now()+interval '1 hour')`,
      [deliveryId, board.id, source, target, sender.id, recipient.id, sourceId, inboxId, senderRun],
    );
    await db.query("COMMIT");
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto("/");
    await page.getByLabel("切换画布").click();
    await page.getByRole("button", { name: board.title!, exact: true }).click();
    await page.locator(`[data-node-id="${sender.id}"]`).dblclick();
    const panel = page.locator(".agent-inspector");
    const bubble = panel
      .locator("article.agent-event-message")
      .filter({ hasText: "请查看这条协作消息" });
    await expect(bubble.getByText("未读", { exact: true })).toBeVisible();
    await bubble.getByRole("button", { name: "加急消息", exact: true }).click();
    await expect(bubble).toHaveClass(/agent-event-expedited/);
    await expect(bubble.getByText("加急中", { exact: false })).toBeVisible();
    await page.screenshot({ path: info.outputPath("unread-expedited.png") });
    await db.query("BEGIN");
    await db.query(
      "update messages set consumed_at=now(),consumed_run_id=$2 where conversation_id=$1",
      [target, recipientRun],
    );
    await db.query("update conversations set consumed_message_seq=message_seq where id=$1", [
      target,
    ]);
    const seq = (
      await db.query("update canvases set event_seq=event_seq+1 where id=$1 returning event_seq", [
        board.id,
      ])
    ).rows[0].event_seq;
    await db.query(
      "insert into canvas_events(canvas_id,seq,type,payload) values($1,$2,'conversation.changed',$3)",
      [
        board.id,
        seq,
        JSON.stringify({ conversationId: source, agentId: sender.id, recipients: [recipient.id] }),
      ],
    );
    await db.query("select pg_notify('intrica_changes',$1)", [board.id]);
    await db.query("COMMIT");
    await expect(bubble.getByText("已读", { exact: true })).toBeVisible();
    await expect(bubble.getByText("已优先送达", { exact: false })).toBeVisible();
    await expect(bubble.getByRole("button", { name: "加急消息" })).toHaveCount(0);
    await page.reload();
    await page.locator(`[data-node-id="${sender.id}"]`).dblclick();
    await expect(bubble).toHaveClass(/agent-event-expedited/);
    await expect(bubble.getByText("已读", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "暂停协作", exact: true }).click();
    await expect(panel.getByText("协作已暂停", { exact: true })).toBeVisible();
    await page.reload();
    await page.locator(`[data-node-id="${sender.id}"]`).dblclick();
    await expect(panel.getByRole("button", { name: "恢复协作", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("read-priority-paused.png") });
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
