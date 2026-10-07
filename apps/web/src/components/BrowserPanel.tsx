import { useEffect, useRef, useState } from "react";
import type { BrowserBridge, BrowserCommand, BrowserState } from "../desktop/bridge";
import { tr, useTranslation } from "../i18n";
import { safeWebUrl } from "../utils/web-url";
import { IconBrowser, IconButton, IconClose, IconRefresh } from "./icons";

const emptyState: BrowserState = {
  url: "",
  title: "",
  loading: false,
  error: "",
  canGoBack: false,
  canGoForward: false,
};
type BrowserPanelProps = {
  active?: boolean;
  target?:
    | {
        url: string;
        nonce: string;
      }
    | undefined;
};
export function BrowserPanel(props: BrowserPanelProps) {
  useTranslation();

  const bridge = window.intricaDesktop?.browser;
  if (!bridge) return <RemoteBrowserPanel {...props} />;
  return <NativeBrowserPanel {...props} bridge={bridge} />;
}
function RemoteBrowserPanel({ target }: BrowserPanelProps) {
  useTranslation();

  return (
    <div className="workspace-browser remote-browser">
      <div className="workspace-empty">
        <IconBrowser size={28} />
        <h2>{tr("浏览与收集")}</h2>
        <p>{tr("当前 Server 未提供浏览器能力。请在 Electron 客户端中使用受限的本机浏览器。")}</p>
        {target?.url && (
          <a href={safeWebUrl(target.url) ?? "#"} target="_blank" rel="noreferrer">
            {tr("在系统浏览器打开当前地址")}
          </a>
        )}
      </div>
    </div>
  );
}
function NativeBrowserPanel({
  bridge,
  active = true,
  target,
}: BrowserPanelProps & {
  bridge: BrowserBridge;
}) {
  useTranslation();

  const [address, setAddress] = useState("");
  const [state, setState] = useState(emptyState);
  const [error, setError] = useState("");
  const host = useRef<HTMLElement>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!target) return;
    const value = safeWebUrl(target.url);
    if (!value) return;
    let closed = false;
    editing.current = false;
    setAddress(value);
    setError("");
    void bridge
      .command("navigate", value)
      .then((next) => {
        if (!closed) setState(next);
      })
      .catch((e) => {
        if (!closed) setError(String(e));
      });
    return () => {
      closed = true;
    };
  }, [bridge, target]);
  const entered = address.trim();
  const localAddress = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(entered);
  const url = safeWebUrl(
    localAddress ? `http://${entered}` : entered.includes(":") ? entered : `https://${entered}`,
  );
  useEffect(
    () =>
      bridge.subscribe((next) => {
        setState(next);
        if (!editing.current && next.url) setAddress(next.url);
      }),
    [bridge],
  );
  useEffect(() => {
    if (!host.current) return;
    const bounds = () => {
      const rect = host.current?.getBoundingClientRect();
      void bridge
        .command(
          "bounds",
          active && rect?.width && rect.height
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
        )
        .catch((error) => setError(String(error)));
    };
    const observer = new ResizeObserver(bounds);
    observer.observe(host.current);
    window.addEventListener("resize", bounds);
    bounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", bounds);
      void bridge.command("bounds", null).catch(() => {});
    };
  }, [bridge, active]);
  const command = async (name: BrowserCommand, value?: string) => {
    setError("");
    try {
      setState(await bridge.command(name, value));
    } catch (error) {
      setError(String(error));
    }
  };
  const navigate = () => {
    if (!url) {
      setError(tr("请输入 HTTP 或 HTTPS 网页地址"));
      return;
    }
    editing.current = false;
    void command("navigate", url);
    const rect = host.current?.getBoundingClientRect();
    void bridge
      .command(
        "bounds",
        active && rect?.width && rect.height
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null,
      )
      .catch((error) => setError(String(error)));
  };
  return (
    <div className="workspace-browser">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <IconButton
          label={tr("上一页")}
          disabled={!state.canGoBack}
          onClick={() => void command("back")}
        >
          <span aria-hidden="true">←</span>
        </IconButton>
        <IconButton
          label={tr("下一页")}
          disabled={!state.canGoForward}
          onClick={() => void command("forward")}
        >
          <span aria-hidden="true">→</span>
        </IconButton>
        {state.url && (
          <a
            className="browser-page-link"
            href={state.url}
            draggable
            title={tr("将当前网页拖到画布")}
            aria-label={tr("将当前网页拖到画布")}
            onClick={(event) => event.preventDefault()}
            onDragStart={(event) => {
              event.dataTransfer.setData("text/uri-list", state.url);
              event.dataTransfer.setData("text/plain", `${state.title || state.url}\n${state.url}`);
            }}
          >
            <IconBrowser size={16} />
          </a>
        )}
        <input
          aria-label={tr("网页地址")}
          placeholder={tr("输入网址\u2026")}
          value={address}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
          }}
          onChange={(event) => setAddress(event.target.value)}
        />
        <IconButton
          label={
            state.loading ? tr("停止加载网页") : url === state.url ? tr("刷新网页") : tr("打开网页")
          }
          onClick={() =>
            state.loading
              ? void command("stop")
              : url === state.url
                ? void command("reload")
                : navigate()
          }
        >
          {state.loading ? (
            <IconClose />
          ) : url === state.url ? (
            <IconRefresh />
          ) : (
            <span aria-hidden="true">→</span>
          )}
        </IconButton>
      </form>
      {(error || state.error) && (
        <p role="alert" className="workspace-error">
          {error || state.error}
        </p>
      )}
      {state.loading && (
        <div className="browser-progress" role="status" aria-label={tr("正在加载网页")} />
      )}
      <section className="native-browser-host" ref={host} aria-label={tr("网页浏览区域")}>
        {!state.url && (
          <div className="workspace-empty">
            <IconBrowser size={28} />
            <h2>{tr("浏览与收集")}</h2>
            <p>{tr("输入网址，开始浏览。")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
