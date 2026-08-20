import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

interface ContextMenuPosition {
  x: number;
  y: number;
}

export function useSessionContextMenu(
  identity: string,
  onAction?: () => void,
  actionLabel = "Delete",
) {
  const [position, setPosition] = useState<ContextMenuPosition | null>(null);

  const close = useCallback(() => setPosition(null), []);
  const onContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!onAction) return;
    event.preventDefault();
    setPosition({ x: event.clientX, y: event.clientY });
  }, [onAction]);

  useEffect(() => {
    if (!position) return;
    const onPointerDown = () => close();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, position]);

  const menu = position && onAction
    ? createPortal(
        <div
          className="session-context-menu"
          role="menu"
          aria-label={`Actions for ${identity}`}
          style={{ left: position.x, top: position.y }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              close();
              onAction();
            }}
          >
            {actionLabel}
          </button>
        </div>,
        document.body,
      )
    : null;

  return { onContextMenu, menu };
}
