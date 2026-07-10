// Pointer-based, vertical-only drag-to-reorder for a list of rows (e.g. the
// model chain table). Unlike native HTML5 drag-and-drop — which drags a whole
// ghost image around in both axes and gives no built-in way to show "this is
// where it'll land" — this constrains movement to the Y axis entirely (there's
// simply no X transform, so the row can't drift sideways) and tracks a live
// "drop target" index the caller renders as a highlighted slot behind the
// floating row, instead of just dimming the dragged item.
//
// Usage: wire `handleProps(i)` onto the drag handle's onPointerDown, attach
// `registerRow(i)` as the row element's ref callback, and apply `rowStyle(i)`
// (a translateY transform, only set on the dragged row) plus your own
// className logic keyed off `dragIndex`/`overIndex`. The hook never mutates
// your list itself — it only calls `onReorder(from, to)` once, on pointer-up.

import { useCallback, useEffect, useRef, useState } from "react";

interface RowRect {
  top: number;
  height: number;
}

export function useVerticalReorder(
  count: number,
  onReorder: (from: number, to: number) => void,
) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [offsetY, setOffsetY] = useState(0);

  const rowEls = useRef<Map<number, HTMLElement>>(new Map());
  const overIndexRef = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);
  // Holds the active drag's teardown, so an unmount mid-drag (e.g. navigating
  // away with the pointer still down) doesn't leave listeners dangling.
  const cancelActive = useRef<(() => void) | null>(null);

  const registerRow = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      if (el) rowEls.current.set(i, el);
      else rowEls.current.delete(i);
    },
    [],
  );

  const setOver = useCallback((v: number | null) => {
    overIndexRef.current = v;
    setOverIndex(v);
  }, []);

  const reset = useCallback(() => {
    setDragIndex(null);
    setOver(null);
    setOffsetY(0);
    cancelActive.current = null;
    document.body.classList.remove("select-none", "cursor-grabbing");
  }, [setOver]);

  const startDrag = useCallback(
    (
      from: number,
      pointerId: number,
      handle: HTMLElement,
      startClientY: number,
    ) => {
      // Snapshot every row's position ONCE at drag start — cheap for a
      // chain-sized list, and avoids a layout read on every pointermove.
      const rects: RowRect[] = [];
      for (let i = 0; i < count; i++) {
        const r = rowEls.current.get(i)?.getBoundingClientRect();
        rects.push(
          r ? { top: r.top, height: r.height } : { top: 0, height: 0 },
        );
      }

      setDragIndex(from);
      setOver(from);
      setOffsetY(0);
      document.body.classList.add("select-none", "cursor-grabbing");

      const onMove = (e: PointerEvent) => {
        if (rafId.current !== null) return;
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null;
          const delta = e.clientY - startClientY;
          setOffsetY(delta);
          // Which row's slot does the dragged row's (offset) center now fall
          // into? That's the drop target — the row that'll shift to make room.
          const fromRect = rects[from];
          const center = fromRect.top + fromRect.height / 2 + delta;
          let target = from;
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (center >= r.top && center < r.top + r.height) {
              target = i;
              break;
            }
          }
          setOver(target);
        });
      };

      const teardown = () => {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onCancel);
        if (rafId.current !== null) {
          cancelAnimationFrame(rafId.current);
          rafId.current = null;
        }
      };

      const onUp = () => {
        teardown();
        const to = overIndexRef.current;
        if (to !== null && to !== from) onReorder(from, to);
        reset();
      };

      const onCancel = () => {
        teardown();
        reset();
      };

      cancelActive.current = onCancel;
      handle.setPointerCapture(pointerId);
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onCancel);
    },
    [count, onReorder, reset, setOver],
  );

  const handleProps = useCallback(
    (i: number) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return; // primary button/touch only
        e.preventDefault();
        startDrag(i, e.pointerId, e.currentTarget, e.clientY);
      },
      // Prevents the browser from starting a touch-scroll gesture instead of
      // the drag once the handle has captured the pointer.
      style: { touchAction: "none" as const },
    }),
    [startDrag],
  );

  const rowStyle = useCallback(
    (i: number): React.CSSProperties | undefined =>
      i === dragIndex ? { transform: `translateY(${offsetY}px)` } : undefined,
    [dragIndex, offsetY],
  );

  useEffect(() => () => cancelActive.current?.(), []);

  return { dragIndex, overIndex, registerRow, handleProps, rowStyle };
}
