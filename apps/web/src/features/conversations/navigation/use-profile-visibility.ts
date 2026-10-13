import { type RefObject, useEffect } from "react";

/** Observe the name field so the persistent bar takes over when the identity leaves view. */
export function useProfileVisibility(
  scroller: RefObject<HTMLElement | null>,
  profile: RefObject<HTMLElement | null> | undefined,
  onChange: ((visible: boolean) => void) | undefined,
) {
  useEffect(() => {
    const root = scroller.current;
    const target = profile?.current;
    if (!root || !target || !onChange || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((entry) => entry.target === target);
        if (entry) onChange(entry.isIntersecting);
      },
      { root },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scroller, profile, onChange]);
}
