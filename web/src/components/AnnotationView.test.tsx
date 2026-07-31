import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { ApiClient } from "../api";
import type { AnnotationSession } from "../types";
import { AnnotationView } from "./AnnotationView";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

beforeEach(() => {
  mermaidMocks.initialize.mockClear();
  mermaidMocks.render.mockReset().mockResolvedValue({
    svg: '<svg role="img" aria-label="Draft to review diagram"></svg>',
  });
});

const markdownAnnotation: AnnotationSession = {
  id: "annotation-1",
  terminalId: "terminal-1",
  filename: "review.md",
  format: "markdown",
  content: "# Proposal\n\nSelect this sentence.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
  createdAt: "2026-07-30T00:00:00Z",
};

test("renders Mermaid fenced code as an annotation diagram", async () => {
  const { api } = apiWithComplete();
  render(
    <AnnotationView
      annotation={{
        ...markdownAnnotation,
        content: [
          "# Diagram",
          "",
          "```mermaid",
          "flowchart LR",
          "  Draft --> Review",
          "```",
        ].join("\n"),
      }}
      api={api}
      onCompleted={() => undefined}
    />,
  );

  const diagram = await screen.findByRole("figure", { name: "Mermaid diagram" });
  expect(diagram).toHaveClass("annotation-mermaid");
  expect(diagram.querySelector("svg")).toBeVisible();
  expect(diagram.querySelector("code.language-mermaid")).toBeNull();
});

function apiWithComplete(implementation = vi.fn().mockResolvedValue({
  annotationId: "annotation-1",
  comments: [],
})) {
  return {
    api: { completeAnnotation: implementation } as unknown as ApiClient,
    completeAnnotation: implementation,
  };
}

test("renders GFM and turns a text selection into a removable comment", async () => {
  const user = userEvent.setup();
  const { api } = apiWithComplete();
  render(
    <AnnotationView
      annotation={markdownAnnotation}
      api={api}
      onCompleted={() => undefined}
    />,
  );

  expect(screen.getByRole("heading", { name: "Proposal" })).toBeVisible();
  expect(screen.getByRole("table")).toBeVisible();
  const sentence = screen.getByText("Select this sentence.");
  const text = sentence.firstChild;
  if (!text) throw new Error("missing sentence text");
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 11);
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unsupported");
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(sentence);

  expect(screen.getByRole("button", { name: "Comment" })).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: "Comment on selection" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Comment" }));
  expect(screen.getByText("Select this", { selector: "blockquote" })).toBeVisible();
  const selectionEditor = screen.getByRole("textbox", {
    name: "Comment on selection",
  });
  expect(selectionEditor).toHaveFocus();
  await user.type(selectionEditor, "Make this concrete.");
  await user.click(screen.getByRole("button", { name: "Add selection comment" }));
  const saved = screen.getByRole("listitem", { name: "Selection comment 1" });
  expect(within(saved).getByText("Make this concrete.")).toBeVisible();
  await user.click(within(saved).getByRole("button", { name: "Remove comment" }));
  expect(screen.queryByRole("listitem", { name: "Selection comment 1" })).not.toBeInTheDocument();
});

test("submits a global comment and closes the annotation", async () => {
  const user = userEvent.setup();
  const { api, completeAnnotation } = apiWithComplete();
  const onCompleted = vi.fn();
  render(
    <AnnotationView
      annotation={markdownAnnotation}
      api={api}
      onCompleted={onCompleted}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Global comment" }),
    "The overall structure works.",
  );
  expect(
    screen.queryByRole("button", { name: "Add global comment" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send comments" }));

  expect(completeAnnotation).toHaveBeenCalledWith("annotation-1", [
    { kind: "global", body: "The overall structure works." },
  ]);
  expect(onCompleted).toHaveBeenCalledOnce();
});

test("sanitizes active HTML before rendering it", () => {
  const { api } = apiWithComplete();
  const { container } = render(
    <AnnotationView
      annotation={{
        ...markdownAnnotation,
        filename: "review.html",
        format: "html",
        content: `<h1>Safe heading</h1>
          <a href="javascript:alert(1)" onclick="alert(1)">unsafe link</a>
          <img src="http://127.0.0.1/private.png" alt="external resource">
          <video src="https://example.com/video.mp4" autoplay></video>
          <form><input value="secret"></form>
          <iframe src="https://example.com"></iframe>
          <script>alert("x")</script>
          <p style="color:red">Safe paragraph</p>`,
      }}
      api={api}
      onCompleted={() => undefined}
    />,
  );

  expect(screen.getByRole("heading", { name: "Safe heading" })).toBeVisible();
  expect(screen.getByText("Safe paragraph")).not.toHaveAttribute("style");
  expect(
    container.querySelector("script, iframe, form, input, img, video"),
  ).toBeNull();
  const link = screen.getByText("unsafe link").closest("a");
  expect(link).not.toBeNull();
  expect(link).not.toHaveAttribute("href");
  expect(link).not.toHaveAttribute("onclick");
});

test("allows explicit approval with no comments and preserves comments after a failed send", async () => {
  const user = userEvent.setup();
  const complete = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ annotationId: "annotation-1", comments: [] });
  const { api } = apiWithComplete(complete);
  const onCompleted = vi.fn();
  render(
    <AnnotationView
      annotation={markdownAnnotation}
      api={api}
      onCompleted={onCompleted}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Send comments" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Comments could not be sent. Try again.",
  );
  expect(onCompleted).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Send comments" }));
  expect(complete).toHaveBeenNthCalledWith(2, "annotation-1", []);
  expect(onCompleted).toHaveBeenCalledOnce();
});
