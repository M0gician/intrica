import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from "@floating-ui/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../features/settings/context";
import { DesktopUpdateBadge } from "../features/settings/desktop-update-state";
import i18n, { tr, useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { IconChevronDown, IconHome, IconMore, IconPlus, IconSettings } from "./icons";
import { ServerSwitcher } from "./ServerSwitcher";
import "./canvas-switcher.css";
export type CanvasItem = {
  id: string;
  title?: string | undefined;
};
export const canvasName = (canvas?: CanvasItem) =>
  canvas?.title?.trim() || i18n.t("untitledCanvas");
type Props = {
  current?: CanvasItem | undefined;
  canvases: CanvasItem[];
  onSelect?: ((id: string) => void) | undefined;
  onCreate?: ((title?: string) => Promise<boolean>) | undefined;
  onDelete?: ((id: string) => Promise<boolean>) | undefined;
  onRename?: ((id: string, title: string, expectedTitle: string) => Promise<boolean>) | undefined;
};
type Edit = {
  kind: "rename" | "delete";
  canvas: CanvasItem;
  title: string;
};
export function CanvasSwitcher(props: Props) {
  const { t } = useTranslation();
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusId, setFocusId] = useState("");
  const [more, setMore] = useState<CanvasItem | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const savedScroll = useRef(0);
  const focusAfterEdit = useRef<string | null>(null);
  const normalized = query.normalize("NFKC").trim().toLocaleLowerCase();
  const matches = useMemo(
    () =>
      props.canvases.filter((c) =>
        canvasName(c).normalize("NFKC").toLocaleLowerCase().includes(normalized),
      ),
    [props.canvases, normalized],
  );
  const focused = matches.some((c) => c.id === focusId) ? focusId : matches[0]?.id;
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const canvas of props.canvases)
      counts.set(canvasName(canvas), (counts.get(canvasName(canvas)) ?? 0) + 1);
    return counts;
  }, [props.canvases]);
  const floating = useFloating({
    open,
    strategy: "fixed",
    transform: false,
    placement: "bottom-start",
    middleware: [
      offset(8),
      shift({ padding: 12 }),
      size({
        padding: 12,
        apply: ({ availableHeight, elements }) => {
          elements.floating.style.maxHeight = `${Math.max(0, Math.min(560, availableHeight))}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const submenu = useFloating({
    open: Boolean(more),
    strategy: "fixed",
    placement: "bottom-end",
    middleware: [offset(4), flip({ padding: 12 }), shift({ padding: 12, crossAxis: true })],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    if (more && submenu.isPositioned)
      submenu.refs.floating.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [more, submenu.isPositioned, submenu.refs.floating]);
  const close = () => {
    if (busy) return;
    focusAfterEdit.current = null;
    setOpen(false);
    setMore(null);
    setEdit(null);
    setError("");
  };
  const focusRow = useCallback((id?: string) => {
    if (!id) return;
    setFocusId(id);
    rowRefs.current.get(id)?.focus();
  }, []);
  useEffect(() => {
    if (!open || !floating.isPositioned) return;
    active.current?.scrollIntoView({ block: "nearest" });
  }, [open, floating.isPositioned]);
  const editKind = edit?.kind;
  const editCanvasId = edit?.canvas.id;
  useLayoutEffect(() => {
    if (editCanvasId && editKind === "rename") {
      input.current?.focus();
      input.current?.select();
    } else if (editKind) cancel.current?.focus();
    else if (list.current) {
      list.current.scrollTop = savedScroll.current;
      const target = focusAfterEdit.current;
      focusAfterEdit.current = null;
      if (target !== null) {
        if (rowRefs.current.has(target)) focusRow(target);
        else search.current?.focus();
      }
    }
  }, [editKind, editCanvasId, focusRow]);
  useEffect(() => {
    if (!open || busy) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !floating.refs.floating.current?.contains(event.target as Node)
      ) {
        setOpen(false);
        setMore(null);
        setEdit(null);
        setError("");
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, busy, floating.refs.floating]);
  const beginEdit = (kind: Edit["kind"]) => {
    if (!more) return;
    savedScroll.current = list.current?.scrollTop ?? 0;
    setEdit({ kind, canvas: more, title: canvasName(more) });
    setMore(null);
    setError("");
  };
  const cancelEdit = () => {
    focusAfterEdit.current = edit?.canvas.id ?? "";
    setEdit(null);
    setError("");
  };
  const createCanvas = async () => {
    if (busy || !props.onCreate) return;
    setBusy(true);
    setMore(null);
    setError("");
    try {
      if (await props.onCreate(query.trim() || undefined)) {
        setQuery("");
        setOpen(false);
      } else setError(t("createFailed"));
    } catch {
      setError(t("createFailed"));
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!edit || busy || (edit.kind === "rename" && !edit.title.trim())) return;
    setBusy(true);
    setError("");
    try {
      const ok =
        edit.kind === "rename"
          ? await props.onRename?.(edit.canvas.id, edit.title.trim(), edit.canvas.title ?? "")
          : await props.onDelete?.(edit.canvas.id);
      if (!ok) {
        setError(edit.kind === "rename" ? t("renameFailed") : t("deleteFailed"));
        return;
      }
      // Keep the list open for repeated management; deleting an inactive canvas
      // must not navigate away from the canvas the user is working on.
      focusAfterEdit.current = edit.kind === "rename" ? edit.canvas.id : "";
      setEdit(null);
    } catch {
      setError(t("failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="canvas-switcher">
      <button
        className="workspace-home switcher-trigger"
        ref={(element) => {
          trigger.current = element;
          floating.refs.setReference(element);
        }}
        type="button"
        aria-label={t("canvasSwitch")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={props.current ? canvasName(props.current) : t("myCanvas")}
        disabled={busy}
        onClick={() => {
          if (open) close();
          else {
            setQuery("");
            setFocusId(props.current?.id ?? "");
            setError("");
            setOpen(true);
          }
        }}
      >
        <IconHome size={16} />
        <span className="canvas-name">
          {props.current ? canvasName(props.current) : t("myCanvas")}
        </span>
        <span className="canvas-chevron" aria-hidden="true">
          <IconChevronDown />
        </span>
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager
            context={floating.context}
            modal={false}
            initialFocus={search}
            returnFocus={trigger}
          >
            <div
              ref={floating.refs.setFloating}
              className="canvas-menu ui-menu"
              style={{ ...floating.floatingStyles, opacity: floating.isPositioned ? 1 : 0 }}
              role="dialog"
              aria-label={t("canvasDialog")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key !== "Escape" || busy) return;
                event.preventDefault();
                if (more) {
                  setMore(null);
                  moreTrigger.current?.focus();
                } else if (edit) cancelEdit();
                else close();
              }}
            >
              <div className="canvas-menu-controls">
                <div className="canvas-menu-header">
                  <span>
                    {tr("画布")}{" "}
                    <small>
                      {query ? `${matches.length} / ` : ""}
                      {props.canvases.length}
                    </small>
                  </span>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => {
                      close();
                      settings.open();
                    }}
                  >
                    <IconSettings />
                    {t("settings")}
                    <DesktopUpdateBadge />
                  </Button>
                </div>
                <ServerSwitcher
                  disabled={busy || Boolean(edit)}
                  onManage={() => {
                    close();
                    settings.open("servers");
                  }}
                />
                {!edit && (
                  <div className="canvas-search-create">
                    <input
                      className="canvas-search"
                      ref={search}
                      aria-label={t("canvasSearch")}
                      placeholder={t("canvasPlaceholder")}
                      value={query}
                      maxLength={500}
                      disabled={busy}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setMore(null);
                        setError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || busy) return;
                        if (event.key === "ArrowDown" || event.key === "Enter") {
                          event.preventDefault();
                          if (event.key === "Enter" && matches[0]) {
                            props.onSelect?.(matches[0].id);
                            close();
                          } else if (event.key === "Enter" && query.trim()) {
                            void createCanvas();
                          } else focusRow(matches[0]?.id);
                        }
                      }}
                    />
                    {props.onCreate && (
                      <Button
                        variant="primary"
                        type="button"
                        aria-label={t("canvasCreate")}
                        disabled={busy}
                        title={
                          query.trim()
                            ? tr("新建「{{v0}}」", { v0: query.trim() })
                            : t("canvasCreate")
                        }
                        onClick={() => void createCanvas()}
                      >
                        <IconPlus size={14} />
                        {busy ? t("creating") : t("create")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {edit ? (
                <form
                  className="canvas-edit-form"
                  aria-label={edit.kind === "rename" ? t("renameCanvas") : t("deleteCanvasConfirm")}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit();
                  }}
                >
                  <h2>{edit.kind === "rename" ? t("renameCanvas") : t("deleteCanvas")}</h2>
                  <p className="canvas-edit-title" title={canvasName(edit.canvas)}>
                    {canvasName(edit.canvas)}
                  </p>
                  {edit.kind === "rename" ? (
                    <input
                      ref={input}
                      aria-label={t("canvasName")}
                      value={edit.title}
                      maxLength={500}
                      disabled={busy}
                      onChange={(event) => setEdit({ ...edit, title: event.target.value })}
                    />
                  ) : (
                    <p>{t("deleteCanvasHint")}</p>
                  )}
                  {error && (
                    <p className="canvas-menu-error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="canvas-edit-actions">
                    <Button
                      variant="default"
                      ref={cancel}
                      type="button"
                      disabled={busy}
                      onClick={cancelEdit}
                    >
                      {t("cancel")}
                    </Button>
                    <Button
                      variant={edit.kind === "rename" ? "primary" : "danger"}
                      type="submit"
                      disabled={busy || (edit.kind === "rename" && !edit.title.trim())}
                    >
                      {busy
                        ? t("saving")
                        : edit.kind === "rename"
                          ? t("saveName")
                          : t("confirmDeleteCanvas")}
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <ul
                    className="canvas-menu-list"
                    aria-label={t("canvasList")}
                    ref={list}
                    onScroll={() => setMore(null)}
                  >
                    {matches.map((canvas, index) => (
                      <li
                        key={canvas.id}
                        className="canvas-menu-row"
                        data-canvas-id={canvas.id}
                        data-current={canvas.id === props.current?.id || undefined}
                      >
                        <button
                          type="button"
                          className="canvas-option"
                          disabled={busy}
                          aria-label={canvasName(canvas)}
                          aria-current={canvas.id === props.current?.id ? "page" : undefined}
                          tabIndex={canvas.id === focused ? 0 : -1}
                          title={canvasName(canvas)}
                          ref={(element) => {
                            if (element) rowRefs.current.set(canvas.id, element);
                            else rowRefs.current.delete(canvas.id);
                            if (canvas.id === props.current?.id) active.current = element;
                          }}
                          onFocus={() => setFocusId(canvas.id)}
                          onClick={() => {
                            props.onSelect?.(canvas.id);
                            close();
                          }}
                          onKeyDown={(event) => {
                            const next =
                              event.key === "ArrowDown"
                                ? matches[Math.min(index + 1, matches.length - 1)]
                                : event.key === "ArrowUp"
                                  ? matches[Math.max(0, index - 1)]
                                  : event.key === "Home"
                                    ? matches[0]
                                    : event.key === "End"
                                      ? matches.at(-1)
                                      : null;
                            if (next) {
                              event.preventDefault();
                              focusRow(next.id);
                            }
                            if (event.key === "ArrowRight") {
                              event.preventDefault();
                              event.currentTarget.nextElementSibling instanceof HTMLButtonElement &&
                                event.currentTarget.nextElementSibling.focus();
                            }
                          }}
                        >
                          <IconHome size={16} />
                          <span className="canvas-option-label">
                            <span className="canvas-option-title">{canvasName(canvas)}</span>
                            {(duplicateNames.get(canvasName(canvas)) ?? 0) > 1 && (
                              <small>{canvas.id.slice(-8)}</small>
                            )}
                          </span>
                          {canvas.id === props.current?.id && <span aria-hidden="true">✓</span>}
                        </button>
                        {(props.onRename || props.onDelete) && (
                          <button
                            type="button"
                            className="canvas-more"
                            disabled={busy}
                            aria-label={t("moreCanvas", { name: canvasName(canvas) })}
                            title={tr("更多操作")}
                            aria-haspopup="menu"
                            aria-expanded={more?.id === canvas.id}
                            tabIndex={canvas.id === focused ? 0 : -1}
                            onFocus={() => setFocusId(canvas.id)}
                            onKeyDown={(event) => {
                              if (event.key === "ArrowLeft") {
                                event.preventDefault();
                                focusRow(canvas.id);
                              }
                            }}
                            onClick={(event) => {
                              moreTrigger.current = event.currentTarget;
                              submenu.refs.setReference(event.currentTarget);
                              setMore(more?.id === canvas.id ? null : canvas);
                            }}
                          >
                            <IconMore size={16} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {matches.length === 0 && (
                    <p className="canvas-menu-empty">
                      {query.trim() ? t("noCanvasMatch") : t("noCanvases")}
                    </p>
                  )}
                  {error && (
                    <p className="canvas-menu-error" role="alert">
                      {error}
                    </p>
                  )}
                </>
              )}
              {more && (
                <FloatingFocusManager
                  context={submenu.context}
                  modal={false}
                  returnFocus={moreTrigger}
                >
                  <div
                    ref={submenu.refs.setFloating}
                    style={{
                      ...submenu.floatingStyles,
                      visibility: submenu.isPositioned ? "visible" : "hidden",
                    }}
                    className="canvas-row-menu ui-menu"
                    role="menu"
                    aria-label={t("actionsCanvas", { name: canvasName(more) })}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        const buttons = [
                          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
                        ];
                        const current = buttons.indexOf(
                          document.activeElement as HTMLButtonElement,
                        );
                        buttons[
                          (current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                            buttons.length
                        ]?.focus();
                      }
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        setMore(null);
                        moreTrigger.current?.focus();
                      }
                    }}
                  >
                    {props.onRename && (
                      <Button
                        variant="menu"
                        type="button"
                        role="menuitem"
                        onClick={() => beginEdit("rename")}
                      >
                        {t("rename")}
                      </Button>
                    )}
                    {props.onDelete && (
                      <Button
                        variant="menu"
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => beginEdit("delete")}
                      >
                        {t("deleteCanvas")}
                      </Button>
                    )}
                  </div>
                </FloatingFocusManager>
              )}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  );
}
