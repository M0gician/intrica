import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import type { ModelSelection, ModelThinkingLevel } from "@intrica/contracts";
import { useEffect, useRef, useState } from "react";
import { useOptionalModels } from "../data/models";
import { useSettings } from "../features/settings/context";
import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { IconChevronDown, IconModel } from "./icons";
import { ReasoningEffort } from "./ReasoningEffort";
import "./model-picker.css";

export function ModelPicker({
  label,
  selection = null,
  onSelectionChange,
}: {
  label?: string;
  selection?: ModelSelection | null;
  onSelectionChange?: (
    selection: ModelSelection | null,
  ) => void | boolean | Promise<void> | Promise<boolean>;
} = {}) {
  const { t } = useTranslation();
  const state = useOptionalModels();
  const settings = useSettings();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const floating = useFloating({
    open,
    strategy: "fixed",
    placement: "bottom-end",
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12, crossAxis: true })],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (
        !root.current?.contains(e.target as Node) &&
        !floating.refs.floating.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, floating.refs.floating]);
  if (!state) return null;
  const { data } = state,
    scoped = Boolean(onSelectionChange);
  const selected = data?.profiles.find((p) => p.id === (selection?.profileId ?? data.selectedId));
  const missing = scoped && selection && !selected;
  const level = selection?.thinkingLevel ?? selected?.thinkingLevel ?? "off";
  const choose = async (id: string | null, thinkingLevel?: ModelThinkingLevel) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (onSelectionChange) {
        const result = await onSelectionChange(
          id
            ? {
                profileId: id,
                thinkingLevel:
                  thinkingLevel ?? data?.profiles.find((p) => p.id === id)?.thinkingLevel ?? "off",
              }
            : null,
        );
        if (result === false) throw new Error(t("failed"));
      } else await state.select(id, thinkingLevel);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="model-picker" ref={root}>
      <button
        className="model-trigger"
        type="button"
        ref={floating.refs.setReference}
        aria-label={label ?? t("selectModel")}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void state.refresh();
        }}
      >
        <IconModel size={15} />
        <span>{missing ? t("missingModel") : selected?.modelId || t("notConfigured")}</span>
        {scoped && !selection && <small title={t("followDefault")}>{t("defaultLabel")}</small>}
        {level !== "off" && <small>{level}</small>}
        <span className="model-trigger-chevron">
          <IconChevronDown />
        </span>
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={floating.context} modal={false}>
            <div
              ref={floating.refs.setFloating}
              style={floating.floatingStyles}
              className="model-menu ui-menu"
              role="dialog"
              aria-label={t("model")}
              data-floating-ready={floating.isPositioned}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setOpen(false);
              }}
            >
              <div className="model-menu-heading">
                {t("model")}
                <span>{scoped ? label : t("defaultModel")}</span>
              </div>
              <div className="model-options" role="listbox" aria-label={t("model")}>
                {scoped && (
                  <Button
                    variant="menu"
                    role="option"
                    aria-selected={!selection}
                    type="button"
                    disabled={busy}
                    onClick={() => void choose(null)}
                  >
                    {t("followDefault")}
                  </Button>
                )}
                {data?.profiles.map((profile) => (
                  <Button
                    variant="menu"
                    type="button"
                    role="option"
                    aria-selected={
                      scoped ? selection?.profileId === profile.id : data.selectedId === profile.id
                    }
                    key={profile.id}
                    disabled={busy}
                    onClick={() => void choose(profile.id)}
                  >
                    <span>
                      <strong>{profile.modelId}</strong>
                      <small>{profile.name}</small>
                    </span>
                    {selected?.id === profile.id && "✓"}
                  </Button>
                ))}
              </div>
              {selected && selected.thinkingLevels.length > 1 && (
                <ReasoningEffort
                  key={selected.id}
                  levels={selected.thinkingLevels}
                  value={level}
                  disabled={busy}
                  onChange={(level) => choose(selected.id, level)}
                />
              )}
              {(error || state.error) && <p role="alert">{error || state.error}</p>}
              <div className="model-menu-actions">
                <Button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    settings.open("models");
                  }}
                >
                  {t("manageModels")}
                </Button>
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  );
}
export function ModelLabel() {
  const { t } = useTranslation();
  const state = useOptionalModels();
  return <span className="model-label">{state?.data?.active.modelId || t("notConfigured")}</span>;
}
