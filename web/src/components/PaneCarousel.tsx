import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export const MIN_PANE_WIDTH = 360;

export function visiblePaneCount(width: number, paneCount: number): number {
  if (paneCount <= 0) return 0;
  return Math.min(
    paneCount,
    Math.max(1, Math.floor(width / MIN_PANE_WIDTH)),
  );
}

export interface PaneCarouselItem {
  id: string;
  label: string;
  content: ReactNode;
  cached?: boolean;
}

interface PaneCarouselProps {
  panes: PaneCarouselItem[];
  focusedID: string | null;
  onFocus: (id: string) => void;
}

export function PaneCarousel({
  panes,
  focusedID,
  onFocus,
}: PaneCarouselProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const manualNavigationRef = useRef(false);
  const previousFocusedIDRef = useRef<string | null | undefined>(undefined);
  const previousPaneKeyRef = useRef<string | undefined>(undefined);
  const previousVisibleCountRef = useRef<number | undefined>(undefined);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [offset, setOffset] = useState(0);
  const displayedPanes = useMemo(
    () => panes.filter((pane) => !pane.cached),
    [panes],
  );
  const visibleCount = visiblePaneCount(viewportWidth, displayedPanes.length);
  const maxOffset = Math.max(0, displayedPanes.length - visibleCount);
  const paneKey = useMemo(
    () => displayedPanes.map((pane) => pane.id).join("\0"),
    [displayedPanes],
  );
  const focusedIndex = displayedPanes.findIndex((pane) => pane.id === focusedID);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? viewport.clientWidth;
      setViewportWidth(width);
    });
    setViewportWidth(viewport.clientWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (maxOffset === 0) manualNavigationRef.current = false;
    setOffset((current) => Math.min(current, maxOffset));
  }, [maxOffset]);

  useLayoutEffect(() => {
    const focusOrPanesChanged =
      previousFocusedIDRef.current !== focusedID ||
      previousPaneKeyRef.current !== paneKey;
    const capacityChanged =
      previousVisibleCountRef.current !== visibleCount;
    previousFocusedIDRef.current = focusedID;
    previousPaneKeyRef.current = paneKey;
    previousVisibleCountRef.current = visibleCount;
    if (
      !focusOrPanesChanged &&
      (!capacityChanged || manualNavigationRef.current)
    ) {
      return;
    }
    if (focusOrPanesChanged) manualNavigationRef.current = false;
    if (focusedIndex < 0 || visibleCount === 0) return;
    setOffset((current) => {
      if (focusedIndex < current) return focusedIndex;
      if (focusedIndex >= current + visibleCount) {
        return Math.min(maxOffset, focusedIndex - visibleCount + 1);
      }
      return Math.min(current, maxOffset);
    });
  }, [focusedID, focusedIndex, maxOffset, paneKey, visibleCount]);

  if (panes.length === 0) return null;

  const paneWidth = Math.max(
    MIN_PANE_WIDTH,
    viewportWidth / Math.max(visibleCount, 1),
  );
  const railStyle = {
    "--pane-width": `${paneWidth}px`,
    "--pane-translate": `${-offset * paneWidth}px`,
  } as CSSProperties;

  return (
    <div
      ref={viewportRef}
      className="pane-carousel"
      data-visible-count={visibleCount}
    >
      <div className="pane-carousel-track" style={railStyle}>
        {panes.map((pane) => {
          const index = displayedPanes.findIndex((displayedPane) => displayedPane.id === pane.id);
          const displayed = index >= 0;
          const visible =
            displayed && index >= offset && index < offset + visibleCount;
          return (
            <div
              key={pane.id}
              className="terminal-pane"
              data-active={focusedID === pane.id}
              data-visible={visible}
              data-cached={pane.cached ? "true" : undefined}
              hidden={pane.cached}
              aria-hidden={!visible}
              aria-label={pane.label}
              onMouseDown={() => onFocus(pane.id)}
            >
              {pane.content}
            </div>
          );
        })}
      </div>
      {offset > 0 && (
        <Button
          className="pane-carousel-control pane-carousel-control-previous"
          type="button"
          variant="outline"
          size="icon"
          aria-label="Show previous pane"
          onClick={() => {
            manualNavigationRef.current = true;
            setOffset((current) => Math.max(0, current - 1));
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
      )}
      {offset < maxOffset && (
        <Button
          className="pane-carousel-control pane-carousel-control-next"
          type="button"
          variant="outline"
          size="icon"
          aria-label="Show next pane"
          onClick={() => {
            manualNavigationRef.current = true;
            setOffset((current) => Math.min(maxOffset, current + 1));
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
