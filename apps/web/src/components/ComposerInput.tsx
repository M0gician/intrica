import { type ComponentProps, useCallback, useLayoutEffect, useRef, useState } from "react";
/** The text area alone grows to one third of the viewport; its toolbar stays visible. */
export function ComposerInput(props: ComponentProps<"textarea">) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [below, setBelow] = useState(false);
  const measureScroll = useCallback(() => {
    const el = field.current;
    if (el) setBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 4);
  }, []);
  const resizeInput = useCallback(() => {
    const el = field.current;
    if (!el) return;
    const scroll = el.scrollTop;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`;
    el.scrollTop = scroll;
    measureScroll();
  }, [measureScroll]);
  useLayoutEffect(() => {
    if (props.value !== undefined) resizeInput();
  }, [props.value, resizeInput]);
  useLayoutEffect(() => {
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        resizeInput();
      }
    });
    if (field.current) observer.observe(field.current);
    window.addEventListener("resize", resizeInput);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeInput);
    };
  }, [resizeInput]);
  return (
    <div className={`composer-input${below ? " has-more-below" : ""}`}>
      <textarea
        {...props}
        ref={field}
        onScroll={(event) => {
          measureScroll();
          props.onScroll?.(event);
        }}
      />
    </div>
  );
}
