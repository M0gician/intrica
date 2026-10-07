import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "../../i18n";

function composerPadding(reference: unknown) {
  const header =
    reference instanceof Element
      ? reference.closest(".workspace-panel")?.querySelector(".panel-header")
      : null;
  return {
    top: Math.max(12, (header?.getBoundingClientRect().bottom ?? 0) + 8),
    right: 12,
    bottom: 12,
    left: 12,
  };
}
export function ComposerPopover({
  label,
  caption,
  icon,
  open,
  onOpenChange,
  returnFocus,
  children,
}: {
  label: string;
  caption?: string;
  icon: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  useTranslation();

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open,
    onOpenChange,
    placement: "top-start",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip(({ elements }) => ({ padding: composerPadding(elements.reference) })),
      shift(({ elements }) => ({ padding: composerPadding(elements.reference) })),
      size(({ elements }) => ({
        padding: composerPadding(elements.reference),
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        },
      })),
    ],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context, { bubbles: false }),
    useRole(context, { role: "dialog" }),
  ]);
  return (
    <>
      <button
        type="button"
        className="agent-composer-control"
        aria-label={label}
        title={label}
        ref={refs.setReference}
        {...getReferenceProps()}
      >
        {icon}
        {caption && <span>{caption}</span>}
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            modal={false}
            returnFocus={returnFocus?.current ? returnFocus : Boolean(caption)}
          >
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              data-floating-ready={isPositioned}
              className="agent-composer-popover"
              role="dialog"
              aria-label={label}
              {...getFloatingProps({
                onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
                onClick: (event: React.MouseEvent) => event.stopPropagation(),
                onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
                onContextMenu: (event: React.MouseEvent) => event.stopPropagation(),
                onKeyDown: (event: React.KeyboardEvent) => {
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    onOpenChange(false);
                    (
                      returnFocus?.current ?? (refs.domReference.current as HTMLElement | null)
                    )?.focus({ preventScroll: true });
                  }
                },
              })}
            >
              {children}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
