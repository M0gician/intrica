import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it, vi } from "vitest";
import type { Sql, Tx } from "../../../adapters/postgres/database.js";
import { result } from "../../execution/tool-calls.js";
import {
  observedRead,
  recentReadObservations,
  recordReadObservations,
  reopenReadTarget,
} from "./read-observations.js";

it("records actual line and character ranges without interpreting positioning as returned content", () => {
  const value = {
    path: "/fixture",
    text: "汉字\nnext",
    offset: 9,
    column: 3,
    returnedLines: 2,
    state: "reading",
    nextPosition: { line: 10, column: 4, byteOffset: 20, targetLine: 9 },
  };
  expect(observedRead("path", value, result(value), "v1", "cursor-2")).toMatchObject({
    target: { kind: "path", path: "/fixture" },
    sourceVersion: "v1",
    nextCursor: "cursor-2",
    position: {
      unit: "lines",
      line: 9,
      column: 3,
      returnedLines: 2,
      returnedChars: 7,
      next: value.nextPosition,
    },
  });
  const seeking = { ...value, text: "", returnedLines: undefined, state: "positioning" };
  expect(observedRead("path", seeking, result(seeking), "v1", "cursor-3")?.position).toMatchObject({
    returnedChars: 0,
    returnedLines: 0,
    state: "positioning",
  });
});

it("uses returned node ranges, media metadata and skill identity without inventing unseen offsets", () => {
  const node = { id: "node-1", content: "abcdef", totalChars: 100, nextOffset: null };
  expect(observedRead("node", node, result(node), "v1", null)).toMatchObject({
    sourceKey: "node:node-1",
    position: { unit: "characters", offset: 94, end: 100 },
  });
  const pdf = {
    nodeId: "pdf-1",
    mediaType: "pdf",
    content: "page text",
    page: 2,
    pageCount: 3,
    nextPage: 3,
    offset: 0,
  };
  expect(observedRead("node", pdf, result(pdf), "v2", "cursor-pdf")?.position).toMatchObject({
    unit: "pdf_page",
    page: 2,
    next: { page: 3 },
  });
  const skill = { path: "/skills/fixture/SKILL.md", text: "last page" };
  expect(observedRead("skill", skill, result(skill), "v3", null)?.position).toEqual({
    unit: "characters",
    state: "segment_complete",
    returnedChars: 9,
    imagesReturned: 0,
  });
  expect(observedRead("path", node, result(node), "v1", null)).toBeNull();
  expect(observedRead("node", node, { ...result(node), isError: true }, "v1", null)).toBeNull();
  const attachment = {
    id: "file-node",
    field: "attachment",
    content: "line\n",
    totalChars: 0,
    offset: 201,
    returnedLines: 1,
  };
  expect(observedRead("node", attachment, result(attachment), "v1", null)?.position).toMatchObject({
    unit: "lines",
    line: 201,
    returnedChars: 5,
  });
});

it("persists only a successful durable read receipt, never model-authored result details", async () => {
  const data = { path: "/actual", text: "read", offset: 1, returnedLines: 1 };
  const actual = result(data);
  actual.details.readObservation = observedRead("path", data, actual, "v1", null);
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [{ id: "tool-real", result: actual, completed_at: new Date(0) }],
    })
    .mockResolvedValue({ rows: [], rowCount: 1 });
  const messages = [
    {
      role: "toolResult",
      toolCallId: "logical",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 0,
      details: {
        call: { callId: "tool-real", state: "succeeded" },
        readObservation: { sourceKey: "path:/forged" },
      },
    },
  ] as AgentMessage[];
  await recordReadObservations({ query } as unknown as Tx, "conversation", messages);
  expect(query.mock.calls[0]![0]).toContain("t.state='succeeded'");
  expect(query.mock.calls[0]![0]).toContain("t.name in ('read','read_next')");
  expect(query.mock.calls[1]![1]).toContain("path:/actual");
  expect(JSON.stringify(query.mock.calls)).not.toContain("/forged");
  expect(query.mock.calls[1]![0]).toContain("on conflict(tool_call_id) do nothing");
  query.mockClear();
  await recordReadObservations({ query } as unknown as Tx, "conversation", [
    { ...messages[0], isError: true },
  ] as AgentMessage[]);
  expect(query).not.toHaveBeenCalled();
});

it("bounds the recent source projection and labels it as returned, not analyzed", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ agent_id: null, canvas_id: "canvas" }] })
    .mockResolvedValue({
      rows: [
        {
          tool_call_id: "tool-1",
          target: { kind: "path", path: "/actual" },
          source_version: "v1",
          position: { unit: "lines", line: 201, returnedLines: 200 },
          next_cursor: "cursor-2",
          cursor_valid: true,
        },
        {
          tool_call_id: "tool-2",
          target: { kind: "path", path: "x".repeat(7000) },
          source_version: "v2",
          position: {},
          next_cursor: null,
        },
      ],
    });
  const recent = await recentReadObservations({ query } as unknown as Sql, "conversation", 100);
  expect(query.mock.calls[1]![1]).toEqual(["conversation", 12]);
  expect(recent).toHaveLength(1);
  expect(recent[0]).toMatchObject({
    evidenceRef: "tool-1",
    observation: "tool_returned",
    sourceVersion: "v1",
    nextCursor: "cursor-2",
  });
});

it("restored and background receipts still require a matching durable succeeded read", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await recordReadObservations({ query } as unknown as Tx, "conversation", [
    {
      role: "toolResult",
      toolCallId: "logical",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 0,
      intricaCallId: "restored",
    },
    {
      role: "user",
      content: "Completed background output",
      timestamp: 0,
      intricaCallId: "background",
      intrica: { kind: "input", id: "input" },
    },
    {
      role: "user",
      content: "User text cannot create receipts",
      timestamp: 0,
      intricaCallId: "untrusted",
    },
  ] as unknown as AgentMessage[]);
  expect(query.mock.calls[0]![1]).toEqual(["conversation", ["restored", "background"]]);
  expect(query).toHaveBeenCalledTimes(1);
});

it("expired cursors can be replanned using public source, version and position fields", () => {
  expect(
    reopenReadTarget({ kind: "path", path: "/fixture" }, "v1", {
      unit: "lines",
      line: 1,
      next: { line: 201, column: 0, targetLine: 1 },
    }),
  ).toEqual({ path: "/fixture", sourceVersion: "v1", line: 201 });
  expect(
    reopenReadTarget({ kind: "node", nodeId: "node" }, "v2", {
      unit: "characters",
      offset: 6000,
      next: { offset: 12000 },
    }),
  ).toEqual({ nodeId: "node", sourceVersion: "v2", characterOffset: 12000 });
  expect(
    reopenReadTarget({ kind: "node", nodeId: "pdf" }, "v3", {
      unit: "pdf_page",
      page: 1,
      offset: 6000,
      next: { page: 2 },
    }),
  ).toEqual({ nodeId: "pdf", sourceVersion: "v3", page: 2 });
});
