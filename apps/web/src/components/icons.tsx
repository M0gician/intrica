import type * as React from "react";

type IconProps = { size?: number };

function IconBase({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 扩展：一个输入在当前层分出多个结果。 */
export function IconExpand({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="1" y="6" width="3" height="4" rx="1" />
      <path d="M4 8h3m0 0V3h3M7 8h3M7 8v5h3" />
      <rect x="11" y="1.5" width="4" height="3" rx=".7" />
      <rect x="11" y="6.5" width="4" height="3" rx=".7" />
      <rect x="11" y="11.5" width="4" height="3" rx=".7" />
    </IconBase>
  );
}
/** 深入：多个输入进入一个结果空间。 */
export function IconDeepen({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <circle cx="3" cy="2.5" r="1.2" />
      <circle cx="8" cy="2.5" r="1.2" />
      <circle cx="13" cy="2.5" r="1.2" />
      <path d="M3 5l5 3 5-3M8 8v3m-2-2 2 2 2-2" />
      <rect x="3" y="11" width="10" height="4" rx="1" />
    </IconBase>
  );
}
/** 收束：总结节点位于父层，成员保留在内部。 */
export function IconCompress({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="5" y="1" width="6" height="3" rx=".7" />
      <path d="M8 4v3M3 10V7h10v3" />
      <rect x="1" y="10" width="4" height="4" rx=".7" />
      <rect x="6" y="10" width="4" height="4" rx=".7" />
      <rect x="11" y="10" width="4" height="4" rx=".7" />
    </IconBase>
  );
}
export function IconBrowser({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.5" ry="6" />
      <path d="M2 8h12" />
    </IconBase>
  );
}
export function IconChat({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M3 2h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6l-4 3V3a1 1 0 0 1 1-1Z" />
      <path d="M5 5.5h6M5 8.5h4" />
    </IconBase>
  );
}

/** 连接：两个节点一条线。 */
export function IconLink({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="8" r="2" />
      <path d="M6 8h4" />
    </IconBase>
  );
}

/** 删除：垃圾桶。 */
export function IconDelete({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M2.5 4h11M6.5 4V2.5h3V4" />
      <path d="M4 4l.7 9.5h6.6L12 4" />
      <path d="M6.8 6.5v4.5M9.2 6.5v4.5" />
    </IconBase>
  );
}

/** 适应画布：四角扩展。 */
export function IconFit({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M6 2.5H2.5V6M10 2.5H13.5V6M6 13.5H2.5V10M10 13.5H13.5V10" />
    </IconBase>
  );
}

/** 查看详情：侧栏。 */
export function IconInspector({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M9.5 2.5v11" />
      <path d="M11.5 5.5h-1M11.5 8h-1" />
    </IconBase>
  );
}

/** 进入内部：进入容器的箭头。 */
export function IconEnter({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="2.5" y="5" width="8" height="8" rx="1.5" />
      <path d="M13.5 2.5v6H8M10.5 6L8 8.5 10.5 11" />
    </IconBase>
  );
}

export function IconPlus({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M8 3v10M3 8h10" />
    </IconBase>
  );
}

export function IconClose({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </IconBase>
  );
}

export function IconMinus({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M3 8h10" />
    </IconBase>
  );
}

export function IconServer({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="2" y="2" width="12" height="5" rx="1.5" />
      <rect x="2" y="9" width="12" height="5" rx="1.5" />
      <path d="M5 4.5h.01M5 11.5h.01M9 4.5h2M9 11.5h2" />
    </IconBase>
  );
}
export function IconSettings({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M2 4h12M2 8h12M2 12h12" />
      <path d="M5 2v4M11 6v4M6 10v4" />
    </IconBase>
  );
}

/** Shared disclosure indicator for canvas and model selectors. */
export function IconChevronDown({ size = 14 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </IconBase>
  );
}

export function IconChevronLeft({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="m10 3.5-4.5 4.5L10 12.5" />
    </IconBase>
  );
}

export function IconChevronRight({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </IconBase>
  );
}

/** 更多：三个点。 */
export function IconMore({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </IconBase>
  );
}
export function IconBookmark({ size = 16, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <IconBase size={size}>
      <path d="M4 2h8v12l-4-3-4 3Z" fill={filled ? "currentColor" : "none"} />
    </IconBase>
  );
}

/** 文字节点类型图标。 */
export function IconText({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M3 4h10M3 8h10M3 12h6" />
    </IconBase>
  );
}

/** 图片节点类型图标。 */
export function IconImage({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <circle cx="5.5" cy="6" r="1.2" />
      <path d="M3 12l3.5-3.5 2.5 2.5 2-2L13.5 12" />
    </IconBase>
  );
}

/** 容器类型图标。 */
export function IconGroup({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M2.5 5.5a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" />
    </IconBase>
  );
}

export type IconButtonProps = {
  label: string;
  caption?: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

/** 图标按钮：默认只显示图标，悬停/聚焦显示 caption（规范 §6.3）。 */
export function IconButton(props: IconButtonProps) {
  const classNames = ["icon-button"];
  if (props.active) classNames.push("active");
  return (
    <button
      type="button"
      className={classNames.join(" ")}
      aria-label={props.label}
      disabled={props.disabled ?? false}
      onClick={props.onClick}
    >
      {props.children}
      <span className="icon-caption" aria-hidden="true">
        {props.caption ?? props.label}
      </span>
    </button>
  );
}

export function IconCopy({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="5" y="5" width="8" height="9" rx="1.5" />
      <path d="M10 5V2H2v9h3" />
    </IconBase>
  );
}
export function IconCode({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14" />
    </IconBase>
  );
}
export function IconPreview({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M1 8s2-5 7-5 7 5 7 5-2 5-7 5-7-5-7-5Z" />
      <circle cx="8" cy="8" r="2" />
    </IconBase>
  );
}
export function IconSave({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M3 2h8l3 3v9H2V2h1Z" />
      <path d="M5 2v4h6V2M5 14v-5h6v5" />
    </IconBase>
  );
}
export function IconTerminal({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <path d="m4 5 3 3-3 3m5 0h3" />
    </IconBase>
  );
}
export function IconHome({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </IconBase>
  );
}
export function IconRefresh({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M13 5a5.5 5.5 0 1 0 .5 5M13 1v4H9" />
    </IconBase>
  );
}
export function IconArrowUp({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M8 13V3m-5 5 5-5 5 5" />
    </IconBase>
  );
}

export function IconAgent({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 14v-1a5 5 0 0 1 10 0v1z" />
    </IconBase>
  );
}

export function IconModel({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <rect x="4" y="4" width="8" height="8" rx="2" />
      <path d="M6 1.5V4m4-2.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" />
      <path d="M7 7h2v2H7z" />
    </IconBase>
  );
}

export function IconShield({ size = 16 }: IconProps) {
  return (
    <IconBase size={size}>
      <path d="M8 1.5l5.5 2v4c0 3.2-2 5.5-5.5 7-3.5-1.5-5.5-3.8-5.5-7v-4z" />
      <path d="M8 5v3m0 3h.01" />
    </IconBase>
  );
}
