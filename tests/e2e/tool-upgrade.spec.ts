import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { API_URL, DATABASE_URL } from "./environment.mjs";

for (const mode of ["agent", "workspace"] as const) {
  test(`${mode}: verify an older outcome, then explicitly continue with current tools`, async ({
    page,
    request,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "intrica-upgrade-ui-"));
    const path = join(directory, "committed.txt");
    await writeFile(path, "already committed");
    const db = new pg.Client({
      connectionString: DATABASE_URL,
      options: "-c search_path=intrica,public",
    });
    await db.connect();
    try {
      const title = `升级核实 ${mode}`;
      const board = (
        await (
          await request.post(`${API_URL}/api/v2/canvases`, {
            data: { title, idempotencyKey: randomUUID() },
          })
        ).json()
      ).node;
      let agentId: string | undefined;
      let conversationId = randomUUID();
      if (mode === "agent") {
        const node = (
          await (
            await request.post(`${API_URL}/api/v2/nodes`, {
              data: {
                kind: "agent",
                parentId: board.id,
                title: "升级核实员",
                position: { x: 100, y: 100, width: 220, height: 300 },
                agent: { role: "read", persona: "核对执行记录。", enabled: false },
                idempotencyKey: randomUUID(),
              },
            })
          ).json()
        ).node;
        agentId = node.id;
        conversationId = (
          await db.query("select id from conversations where agent_id=$1", [agentId])
        ).rows[0].id;
      } else {
        await db.query("insert into conversations(id,canvas_id) values($1,$2)", [
          conversationId,
          board.id,
        ]);
      }
      const oldRun = randomUUID(),
        pauseRun = randomUUID(),
        attempt = randomUUID(),
        call = randomUUID();
      const args = { newText: "must not replay", oldText: "already committed", path };
      await db.query("begin");
      await db.query(
        `insert into runs(id,canvas_id,subject_id,kind,state,reason,frozen_input,cause_id)
        values($1,$3,$4,'conversation','failed','unknown','{}',$1),
        ($2,$3,$4,'conversation','waiting','tool_contract_upgrade','{}',$2)`,
        [oldRun, pauseRun, board.id, conversationId],
      );
      await db.query("insert into attempts(id,run_id,epoch,state) values($1,$2,1,'failed')", [
        attempt,
        oldRun,
      ]);
      await db.query(
        `insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,result)
        values($1,$2,$3,'old:edit','edit',$4,$5,'external','unknown',$6)`,
        [
          call,
          oldRun,
          attempt,
          JSON.stringify(args),
          createHash("sha256").update(JSON.stringify(args)).digest("hex"),
          JSON.stringify({
            content: [{ type: "text", text: "文件结果需要核实" }],
            details: { interruption: "tool_contract_upgrade" },
            isError: true,
          }),
        ],
      );
      await db.query(
        `insert into tool_calls(id,run_id,attempt_id,logical_call_id,name,args,args_hash,effect_class,state,result)
         select $2,run_id,attempt_id,'old:second',name,args,args_hash,effect_class,state,result from tool_calls where id=$1`,
        [call, randomUUID()],
      );
      await db.query(
        `insert into messages(conversation_id,seq,client_message_id,role,content,run_id)
        values($1,1,'original','user','{"text":"保留的原始任务"}',$2)`,
        [conversationId, oldRun],
      );
      await db.query("update conversations set message_seq=1,consumed_message_seq=1 where id=$1", [
        conversationId,
      ]);
      await db.query("commit");
      const server = await (await request.get(`${API_URL}/api/v2/server`)).json();
      await page.addInitScript(
        ({ serverId, boardId, conversationId }) => {
          localStorage.setItem("intrica:language", "zh-CN");
          localStorage.setItem(
            `intrica:server:${serverId}:intrica:conversation:${serverId}:${boardId}`,
            conversationId,
          );
        },
        { serverId: server.id, boardId: board.id, conversationId },
      );
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto("/");
      await page.getByRole("button", { name: "切换画布", exact: true }).click();
      await page.getByRole("button", { name: title, exact: true }).click();
      if (agentId) await page.locator(`[data-node-id="${agentId}"]`).dblclick();
      else {
        await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
        await page.getByRole("button", { name: "模型会话", exact: true }).click();
      }
      await expect(page.getByRole("status").filter({ hasText: "此会话因升级暂停" })).toBeVisible();
      const review = page.getByRole("region", { name: "核实工具结果", exact: true });
      await expect(review).toHaveCount(2);
      await expect(review.first()).toContainText("committed.txt");
      await expect(review.getByRole("button", { name: "再次执行", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "继续", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "继续", exact: true })).toBeInViewport();
      await expect(page.locator(".agent-progress")).toHaveCount(0);
      await page
        .locator(".workspace-panel")
        .screenshot({ path: test.info().outputPath(`${mode}-upgrade-review.png`) });
      if (mode === "agent") {
        await review.first().getByLabel("核实依据").fill("已查看文件，原始写入已完成。");
        await review.first().getByRole("button", { name: "确认已完成", exact: true }).click();
      } else await review.first().getByRole("button", { name: "放弃操作", exact: true }).click();
      await expect(review).toHaveCount(1);
      await expect(page.getByRole("button", { name: "继续", exact: true })).toBeDisabled();
      await review.getByRole("button", { name: "放弃操作", exact: true }).click();
      await expect(review).toHaveCount(0);
      await expect(page.getByRole("button", { name: "继续", exact: true })).toBeEnabled();
      expect(
        (await db.query("select state,reason from runs where id=$1", [pauseRun])).rows[0],
      ).toEqual({ state: "waiting", reason: "tool_contract_upgrade" });
      expect(
        (
          await db.query("select count(*)::int as n from runs where subject_id=$1", [
            conversationId,
          ])
        ).rows[0].n,
      ).toBe(2);
      await page.getByRole("button", { name: "继续", exact: true }).click();
      await expect
        .poll(
          async () =>
            (
              await db.query("select state from runs where subject_id=$1 and id<>all($2::text[])", [
                conversationId,
                [oldRun, pauseRun],
              ])
            ).rows[0]?.state,
        )
        .toBe("succeeded");
      const currentCalls = (
        await db.query(
          `select t.name,t.state from tool_calls t join runs r on r.id=t.run_id
        where r.subject_id=$1 and r.id<>all($2::text[])`,
          [conversationId, [oldRun, pauseRun]],
        )
      ).rows;
      expect(currentCalls).toEqual([{ name: "read_canvas", state: "succeeded" }]);
      expect(await readFile(path, "utf8")).toBe("already committed");
      await page.reload();
      await expect(page.getByText("此会话因升级暂停。", { exact: false })).toHaveCount(0);
      expect(
        (
          await db.query("select content from messages where conversation_id=$1 and seq=1", [
            conversationId,
          ])
        ).rows[0].content,
      ).toEqual({ text: "保留的原始任务" });
    } finally {
      await db.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
