import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionServices, createSessionConnection } from "../../api/connection";
import { MarkdownLite } from "../../components/MarkdownLite";
import { HtmlFilePreview } from "./HtmlFilePreview";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const origin = { kind: "agent" as const, id: "author", filePath: "/work/report.md" };
const file = (serverId: string) => ({
  serverId,
  path: "/work/image.png",
  name: "image.png",
  mime: "image/png",
  data: "aW1hZ2U=",
});

it("resolves Unicode local Markdown images through source permissions and blocks owner API URLs", async () => {
  const connection = createSessionConnection("", "a");
  connection.transport.request = vi.fn(async () => file("a")) as any;
  render(
    <ConnectionServices.Provider value={connection}>
      <MarkdownLite
        origin={origin}
        text={
          "![picture](sandbox:/work/%E5%9B%BE%20one.png)\n\n![blocked](http://localhost/api/v2/workspace/image?path=/private)\n\n[missing](javascript:alert(1))"
        }
      />
    </ConnectionServices.Provider>,
  );
  expect((await screen.findByRole("img", { name: "picture" })).getAttribute("src")).toBe(
    "data:image/png;base64,aW1hZ2U=",
  );
  expect(document.querySelector('img[src*="/api/"]')).toBeNull();
  expect(document.querySelector('a[href=""]')).toBeNull();
  const url = (connection.transport.request as any).mock.calls[0][0];
  const reference = JSON.parse(
    atob(
      new URL(url, location.href).searchParams
        .get("reference")!
        .replaceAll("-", "+")
        .replaceAll("_", "/"),
    ),
  );
  expect(reference).toMatchObject({
    serverId: "a",
    origin,
    path: "sandbox:/work/%E5%9B%BE%20one.png",
  });
});

it("isolates HTML while resolving local images relative to the document, with no active content", async () => {
  const connection = createSessionConnection("", "html");
  connection.transport.request = vi.fn(async () => file("html")) as any;
  render(
    <ConnectionServices.Provider value={connection}>
      <HtmlFilePreview
        origin={origin}
        text={
          '<base href="https://elsewhere/"><article><img src="image.png"><img src="image.png"><script>bad()</script></article>'
        }
      />
    </ConnectionServices.Provider>,
  );
  const frame = screen.getByTitle("HTML 预览");
  await waitFor(() =>
    expect(frame.getAttribute("srcdoc")).toContain("data:image/png;base64,aW1hZ2U="),
  );
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("srcdoc")).not.toContain("<script>");
  expect(frame.getAttribute("srcdoc")).not.toContain("<base");
  expect(connection.transport.request).toHaveBeenCalledTimes(1);
});

it("ignores a late preview when the same source is opened on another connection", async () => {
  const a = createSessionConnection("", "a"),
    b = createSessionConnection("", "b");
  let late!: (value: unknown) => void;
  a.transport.request = vi.fn(
    () =>
      new Promise((resolve) => {
        late = resolve;
      }),
  ) as any;
  b.transport.request = vi.fn(async () => ({ ...file("b"), data: "bmV3" })) as any;
  const view = (c: typeof a) => (
    <ConnectionServices.Provider value={c}>
      <MarkdownLite origin={origin} text="![picture](image.png)" />
    </ConnectionServices.Provider>
  );
  const { rerender } = render(view(a));
  rerender(view(b));
  await screen.findByRole("img", { name: "picture" });
  await act(async () => late(file("a")));
  expect(screen.getByRole("img", { name: "picture" }).getAttribute("src")).toBe(
    "data:image/png;base64,bmV3",
  );
});
