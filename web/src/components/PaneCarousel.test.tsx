import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps } from "react";
import { PaneCarousel, visiblePaneCount } from "./PaneCarousel";

let reportWidth: (width: number) => void;

class ControlledResizeObserver {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    reportWidth = (width) => {
      this.callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    };
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

const panes: ComponentProps<typeof PaneCarousel>["panes"] = [
  { id: "one", label: "One pane", content: <div>one terminal</div> },
  { id: "two", label: "Two pane", content: <div>two terminal</div> },
  { id: "three", label: "Three pane", content: <div>three terminal</div> },
];

function pane(label: string) {
  return document.querySelector(`[aria-label="${label}"]`);
}

test("fits only whole panes at the minimum pane width", () => {
  expect(visiblePaneCount(359, 3)).toBe(1);
  expect(visiblePaneCount(719, 3)).toBe(1);
  expect(visiblePaneCount(720, 3)).toBe(2);
  expect(visiblePaneCount(1080, 3)).toBe(3);
});

test("keeps cached panes mounted without including them in carousel layout", () => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  const cachedPanes = [
    panes[0],
    { ...panes[1], cached: true },
  ];

  render(
    <PaneCarousel
      panes={cachedPanes}
      focusedID="one"
      onFocus={vi.fn()}
    />,
  );

  act(() => reportWidth(720));

  expect(document.querySelector(".pane-carousel")).toHaveAttribute(
    "data-visible-count",
    "1",
  );
  expect(pane("One pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Two pane")).not.toHaveAttribute("hidden");
  expect(pane("Two pane")).toHaveAttribute("inert");
  expect(screen.getByText("two terminal")).toBeInTheDocument();
});

test("moves the visible window by one mounted pane", async () => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  const user = userEvent.setup();
  render(
    <PaneCarousel
      panes={panes}
      focusedID="one"
      onFocus={vi.fn()}
    />,
  );

  act(() => reportWidth(720));

  expect(pane("One pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Two pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Three pane")).toHaveAttribute("data-visible", "false");
  expect(screen.getByText("one terminal")).toBeInTheDocument();
  expect(screen.getByText("two terminal")).toBeInTheDocument();
  expect(screen.queryByText("three terminal")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show previous pane" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show next pane" }));

  expect(pane("One pane")).toHaveAttribute("data-visible", "false");
  expect(pane("Two pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Three pane")).toHaveAttribute("data-visible", "true");
  expect(screen.queryByText("one terminal")).not.toBeInTheDocument();
  expect(screen.getByText("three terminal")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show previous pane" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Show next pane" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Show previous pane" }));

  expect(pane("One pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Three pane")).toHaveAttribute("data-visible", "false");
  expect(screen.getByText("one terminal")).toBeInTheDocument();
  expect(screen.queryByText("three terminal")).not.toBeInTheDocument();
});

test("reveals a pane when focus moves beyond the visible window", () => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  const { rerender } = render(
    <PaneCarousel
      panes={panes}
      focusedID="one"
      onFocus={vi.fn()}
    />,
  );
  act(() => reportWidth(720));

  rerender(
    <PaneCarousel
      panes={panes}
      focusedID="three"
      onFocus={vi.fn()}
    />,
  );

  expect(pane("One pane")).toHaveAttribute("data-visible", "false");
  expect(pane("Three pane")).toHaveAttribute("data-visible", "true");
});

test("keeps a manually shifted window across equivalent parent renders", async () => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  const user = userEvent.setup();
  const props = {
    focusedID: "one",
    onFocus: vi.fn(),
  };
  const { rerender } = render(
    <PaneCarousel panes={panes} {...props} />,
  );
  act(() => reportWidth(720));
  await user.click(screen.getByRole("button", { name: "Show next pane" }));

  rerender(<PaneCarousel panes={[...panes]} {...props} />);

  expect(pane("One pane")).toHaveAttribute("data-visible", "false");
  expect(pane("Three pane")).toHaveAttribute("data-visible", "true");
});

test("clamps a manually shifted window on resize without revealing stale focus", async () => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  const user = userEvent.setup();
  render(
    <PaneCarousel
      panes={panes}
      focusedID="one"
      onFocus={vi.fn()}
    />,
  );
  act(() => reportWidth(720));
  await user.click(screen.getByRole("button", { name: "Show next pane" }));

  act(() => reportWidth(360));

  expect(pane("One pane")).toHaveAttribute("data-visible", "false");
  expect(pane("Two pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Three pane")).toHaveAttribute("data-visible", "false");

  act(() => reportWidth(1080));

  expect(pane("One pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Two pane")).toHaveAttribute("data-visible", "true");
  expect(pane("Three pane")).toHaveAttribute("data-visible", "true");
  expect(screen.queryByRole("button", { name: "Show previous pane" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show next pane" })).not.toBeInTheDocument();
});
