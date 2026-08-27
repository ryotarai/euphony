import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface SessionContextMenuAction {
  label: string;
  onSelect(): void;
}

export function useSessionContextMenu(
  identity: string,
  onAction?: () => void,
  actionLabel = "Delete",
  additionalActions: SessionContextMenuAction[] = [],
) {
  const [position, setPosition] = useState<ContextMenuPosition | null>(null);

  const close = useCallback(() => setPosition(null), []);
  const onContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!onAction && additionalActions.length === 0) return;
    event.preventDefault();
    setPosition({ x: event.clientX, y: event.clientY });
  }, [additionalActions.length, onAction]);

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

  const actions = [
    ...additionalActions,
    ...(onAction ? [{ label: actionLabel, onSelect: onAction }] : []),
  ];
  const menu = position && actions.length > 0
    ? createPortal(
        <div
          className="session-context-menu"
          role="menu"
          aria-label={`Actions for ${identity}`}
          style={{ left: position.x, top: position.y }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {actions.map((action, index) => (
            <button
              type="button"
              role="menuitem"
              autoFocus={index === 0}
              key={action.label}
              onClick={() => {
                close();
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>,
        document.body,
      )
    : null;

  return { onContextMenu, menu };
}
