import { type CSSProperties, memo } from "react";
import { tr, useTranslation } from "../../../i18n";
import { TICK_WIDTHS } from "./rail-layout";
import type { MessageKey } from "./source";

export const RailTicks = memo(function RailTicks({
  items,
  offset,
  hover,
  visible,
  bookmarks,
  onHover,
  onNavigate,
  anchor,
  tabStop,
}: {
  items: MessageKey[];
  offset: number;
  hover: number | undefined;
  anchor: string;
  tabStop: MessageKey | undefined;
  visible: string;
  bookmarks: string;
  onHover: (seq: MessageKey) => void;
  onNavigate: (seq: MessageKey) => void;
}) {
  useTranslation();
  const active = new Set(visible.split(","));
  const saved = new Set(bookmarks.split(","));
  return (
    <div className="message-rail-group">
      {items.map((seq, index) => {
        const distance = hover === undefined ? 4 : Math.min(4, Math.abs(index - hover));
        return (
          <button
            type="button"
            key={seq}
            data-anchor-key={seq}
            data-preview={hover === index || undefined}
            tabIndex={seq === tabStop ? 0 : -1}
            style={hover === index ? ({ anchorName: anchor } as CSSProperties) : undefined}
            aria-label={tr("跳转到第 {{number}} 条会话记录", { number: offset + index + 1 })}
            aria-current={active.has(String(seq)) ? "location" : undefined}
            data-bookmarked={saved.has(String(seq))}
            onPointerEnter={() => onHover(seq)}
            onFocus={() => onHover(seq)}
            onClick={() => onNavigate(seq)}
          >
            <span style={{ transform: `scaleX(${TICK_WIDTHS[distance]! / 26})` }} />
            {saved.has(String(seq)) && (
              <i
                aria-hidden="true"
                style={{ transform: `translateX(-${TICK_WIDTHS[distance]! + 2}px)` }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
});
