import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

const api = `${API_URL}/api/v2`;
test("底部按钮从外层控制整个 Agent 团队，并停止下属等待中的审批", async ({ page, request }) => {
  const board = (
    await (
      await request.post(`${api}/canvases`, {
        data: { title: "团队批量控制", idempotencyKey: randomUUID() },
      })
    ).json()
  ).node;
  const create = async (parentId: string, title: string) =>
    (
      await (
        await request.post(`${api}/nodes`, {
          data: {
            kind: "agent",
            parentId,
            title,
            agent: { persona: "核对资料", role: "read", enabled: false },
            position: { x: 120, y: 120, width: 220, height: 300 },
            idempotencyKey: randomUUID(),
          },
        })
      ).json()
    ).node;
  const root = await create(board.id, "负责人"),
    child = await create(root.id, "成员"),
    nested = await create(child.id, "嵌套成员");
  await page.goto("/");
  await page.getByLabel("切换画布").click();
  await page.getByRole("button", { name: board.title, exact: true }).click();
  await page.locator(`[data-node-id="${root.id}"]`).click();
  const started = page.waitForResponse(
    (r) => r.url().endsWith("/canvas-agents/batch") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "启动选中 Agent 及其团队" }).click();
  expect(await (await started).json()).toMatchObject({ count: 3, total: 3 });
  const db = new pg.Client({
    connectionString: DATABASE_URL,
    options: "-c search_path=intrica,public",
  });
  await db.connect();
  try {
    await expect
      .poll(async () =>
        Number(
          (
            await db.query(
              "select count(*) from runs where canvas_id=$1 and state in('queued','running')",
              [board.id],
            )
          ).rows[0].count,
        ),
      )
      .toBe(0);
    const conversation = (
      await db.query("select id from conversations where agent_id=$1", [nested.id])
    ).rows[0].id;
    const run = randomUUID(),
      call = randomUUID(),
      approval = randomUUID(),
      attempt = randomUUID();
    await db.query(
      "insert into runs(id,canvas_id,subject_id,kind,state,frozen_input,cause_id,reason) values($1,$2,$3,'conversation','waiting','{}',$1,'approval')",
      [run, board.id, conversation],
    );
    await db.query("insert into attempts(id,run_id,epoch,state) values($1,$2,1,'waiting')", [
      attempt,
      run,
    ]);
    await db.query(
      "insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,approval_id) values($1,$2,$4,'request','request_permission','{}','fixture','graph','waiting',$3)",
      [call, run, approval, attempt],
    );
    await db.query(
      'insert into approvals(id,canvas_id,subject_id,origin_call_id,action,basis,status,expires_at,reason) values($1,$2,$3,$4,\'{"kind":"role","role":"admin"}\',\'{"role":"read","delta":[]}\',\'pending\',now()+interval \'1 hour\',\'团队审批测试\')',
      [approval, board.id, nested.id, call],
    );
    await page.reload();
    await page.locator(`[data-node-id="${root.id}"]`).click();
    // The root is idle; the nested pending member is not rendered in the outer canvas.
    await expect(page.getByRole("button", { name: "停止选中 Agent 及其团队" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("team-stop-pending.png") });
    const stopped = page.waitForResponse(
      (r) => r.url().endsWith("/canvas-agents/batch") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "停止选中 Agent 及其团队" }).click();
    const stoppedTeam = await (await stopped).json();
    expect(stoppedTeam.total).toBe(3);
    // Approval maintenance may already have awakened a manager. Stop the whole
    // team, not an assumed single active run determined by scheduling timing.
    expect(stoppedTeam.count).toBeGreaterThanOrEqual(1);
    expect(stoppedTeam.count).toBeLessThanOrEqual(3);
    expect((await db.query("select state from runs where id=$1", [run])).rows[0].state).toBe(
      "cancelled",
    );
    expect(
      (await db.query("select status from approvals where id=$1", [approval])).rows[0].status,
    ).toBe("cancelled");
    await expect
      .poll(async () =>
        Number(
          (
            await db.query(
              "select count(*) from runs where canvas_id=$1 and state in('queued','running','waiting')",
              [board.id],
            )
          ).rows[0].count,
        ),
      )
      .toBe(0);
    await expect(page.getByRole("button", { name: "启动选中 Agent 及其团队" })).toBeVisible();
  } finally {
    await db.end();
  }
});
