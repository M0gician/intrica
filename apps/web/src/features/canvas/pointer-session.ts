type PointerSession = {
  pointerId: number;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: () => void;
};

let active: (() => void) | undefined;
export const cancelPointerSession = () => active?.();

/** A single pointer owns the gesture; its final sample is applied before commit. */
export function startPointerSession(session: PointerSession) {
  active?.();
  let running = true;
  let frame: number | undefined;
  let pending: PointerEvent | undefined;
  const flush = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    const event = pending;
    pending = undefined;
    if (event) session.onMove(event);
  };
  const cleanup = () => {
    running = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    pending = undefined;
    if (active === cancel) active = undefined;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", cancel);
  };
  const cancel = () => {
    if (!running) return;
    cleanup();
    session.onCancel();
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== session.pointerId) return;
    pending = event;
    if (frame === undefined) frame = requestAnimationFrame(flush);
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== session.pointerId) return;
    pending = event;
    flush();
    cleanup();
    session.onUp(event);
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId === session.pointerId) cancel();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  };
  active = cancel;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", cancel);
  return cancel;
}
