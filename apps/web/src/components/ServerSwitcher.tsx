import {
  autoUpdate,
  FloatingFocusManager,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "../app/connection-context";
import type { ServerProfile } from "../app/preferences";
import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { IconChevronDown, IconServer } from "./icons";

export function ServerSwitcher({
  disabled,
  onManage,
}: {
  disabled: boolean;
  onManage: () => void;
}) {
  const { servers } = useConnection();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const currentItem = useRef<HTMLButtonElement>(null);
  const floating = useFloating({
    open,
    strategy: "fixed",
    placement: "bottom-start",
    middleware: [
      offset(4),
      flip({ padding: 12 }),
      shift({ padding: 12 }),
      size({
        padding: 12,
        apply: ({ availableHeight, rects, elements }) => {
          elements.floating.style.width = `${rects.reference.width}px`;
          elements.floating.style.maxHeight = `${Math.max(0, Math.min(360, availableHeight))}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  if (!servers) return null;
  const label = (profile: ServerProfile) => (profile.local ? t("localServer") : profile.label);
  const current = servers.profiles.find((p) => p.id === servers.activeId);
  const connect = async (profile: ServerProfile) => {
    if (pending) return;
    if (profile.id === servers.activeId) {
      setOpen(false);
      return;
    }
    setPending(profile.id);
    setError("");
    try {
      await servers.connect(profile);
      setOpen(false);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`${t("serverSwitchFailed")} ${t(detail, { defaultValue: detail })}`);
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="canvas-server" ref={root}>
      <button
        className="canvas-server-trigger"
        type="button"
        ref={(element) => {
          trigger.current = element;
          floating.refs.setReference(element);
        }}
        aria-label={t("switchServer")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || Boolean(pending)}
        title={current ? `${label(current)}\n${current.baseUrl}` : t("currentServer")}
        onClick={() => {
          setOpen(!open);
          setError("");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconServer />
        <span className="canvas-server-label">
          <span>{current ? label(current) : t("currentServer")}</span>
          {current?.baseUrl && <small>{current.baseUrl}</small>}
        </span>
        <span className="canvas-chevron">
          <IconChevronDown />
        </span>
      </button>
      {open && (
        <FloatingFocusManager
          context={floating.context}
          modal={false}
          initialFocus={currentItem}
          returnFocus={trigger}
        >
          <div
            ref={floating.refs.setFloating}
            style={{
              ...floating.floatingStyles,
              visibility: floating.isPositioned ? "visible" : "hidden",
            }}
            className="canvas-server-menu ui-menu"
            role="menu"
            aria-label={t("switchServer")}
            aria-busy={Boolean(pending)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
                );
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                        items.length;
                items[next]?.focus();
              }
            }}
          >
            <div className="canvas-server-list">
              {servers.profiles.map((profile) => (
                <Button
                  variant="menu"
                  type="button"
                  key={profile.id}
                  role="menuitemradio"
                  aria-label={label(profile)}
                  aria-checked={profile.id === servers.activeId}
                  disabled={Boolean(pending)}
                  ref={profile.id === servers.activeId ? currentItem : undefined}
                  title={`${label(profile)}\n${profile.baseUrl}`}
                  onClick={() => void connect(profile)}
                >
                  <span className="canvas-server-label">
                    <span>{label(profile)}</span>
                    <small>{profile.baseUrl}</small>
                  </span>
                  {profile.id === servers.activeId && <span aria-hidden="true">✓</span>}
                </Button>
              ))}
            </div>
            <div className="canvas-server-footer">
              {pending && <p role="status">{t("switchingServer")}</p>}
              {error && <p role="alert">{error}</p>}
              <Button
                variant="menu"
                type="button"
                role="menuitem"
                disabled={Boolean(pending)}
                onClick={onManage}
              >
                {t("manageServers")}
              </Button>
            </div>
          </div>
        </FloatingFocusManager>
      )}
    </div>
  );
}
