import { type CSSProperties, useId } from "react";
import { IconMore } from "../../components/icons";
import { Button } from "../../ui/button";

type ConnectionAction = { label: string; action: () => void; danger?: boolean };

export function SettingsMenu({
  label,
  actions,
  disabled,
}: {
  label: string;
  actions: ConnectionAction[];
  disabled: boolean;
}) {
  const id = useId();
  const anchor = `--connection-${id.replaceAll(":", "")}`;
  return (
    <>
      <Button
        type="button"
        variant="quiet"
        size="icon"
        popoverTarget={id}
        style={{ anchorName: anchor } as CSSProperties}
        disabled={disabled}
        aria-label={label}
      >
        <IconMore />
      </Button>
      <section
        id={id}
        popover="auto"
        className="connection-menu"
        data-canvas-ui
        style={{ positionAnchor: anchor } as CSSProperties}
        aria-label={label}
      >
        {actions.map((item, index) => (
          <Button
            key={item.label}
            type="button"
            variant={item.danger ? "danger" : "quiet"}
            autoFocus={index === 0}
            onClick={(event) => {
              event.currentTarget.closest<HTMLElement>("[popover]")!.hidePopover();
              item.action();
            }}
          >
            {item.label}
          </Button>
        ))}
      </section>
    </>
  );
}
