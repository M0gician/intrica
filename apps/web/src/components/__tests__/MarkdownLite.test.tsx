import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownLite } from "../MarkdownLite";

describe("MarkdownLite", () => {
  it("渲染标题、列表、引用", () => {
    render(<MarkdownLite text={"# 一级标题\n## 二级标题\n- 项目一\n* 项目二\n> 引用内容"} />);
    expect(screen.getByRole("heading", { level: 1, name: "一级标题" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "二级标题" })).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["项目一", "项目二"]);
    expect(screen.getByText("引用内容")).toBeTruthy();
  });

  it("渲染代码块并保持等宽原文", () => {
    render(<MarkdownLite text={"前文\n```\nA --> B\n| 流程图 |\n```\n后文"} />);
    const code = document.querySelector("pre code");
    expect(code?.textContent).toBe("A --> B\n| 流程图 |\n");
    expect(screen.getByText("后文")).toBeTruthy();
  });

  it("渲染表格", () => {
    render(<MarkdownLite text={"| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |"} />);
    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "名称" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "香蕉" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "5" })).toBeTruthy();
  });

  it("注入的 HTML/脚本一律按文本渲染（XSS 安全）", () => {
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const { container } = render(<MarkdownLite text={payload} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<script>alert("xss")</script>');
  });

  it("空行分段", () => {
    render(<MarkdownLite text={"第一段\n\n第二段"} />);
    const paragraphs = document.querySelectorAll(".markdown-lite > p");
    expect(paragraphs.length).toBe(2);
  });
});
