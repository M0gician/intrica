import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeNode } from "../../test/factories";
import { MentionComposerInput } from "../MentionComposerInput";

describe("MentionComposerInput", () => {
  it("lists nodes from every nested level and inserts the selected mention", () => {
    const onChange = vi.fn();
    const value = "请检查 @资";
    render(
      <MentionComposerInput
        aria-label="任务"
        nodes={[
          makeNode({ id: "root", parentId: null, kind: "group", title: "我的画布" }),
          makeNode({ id: "group", parentId: "root", kind: "group", title: "资料组" }),
          makeNode({ id: "deep", parentId: "group", title: "资料甲" }),
        ]}
        canvasId="root"
        value={value}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText("任务");
    (input as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
    fireEvent.change(input, { target: { value, selectionStart: value.length } });
    expect(screen.getByRole("option", { name: /资料甲/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /资料甲/ }));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0].target.value).toBe("请检查 @资料甲 ");
  });
  it("matches Chinese labels by pinyin initials", () => {
    render(
      <MentionComposerInput
        aria-label="任务"
        nodes={[
          makeNode({ id: "root", parentId: null, kind: "group", title: "我的画布" }),
          makeNode({ id: "deep", parentId: "root", title: "资料甲" }),
        ]}
        canvasId="root"
        value="@zlj"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: /资料甲/ })).toBeTruthy();
  });
});
