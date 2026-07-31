import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import DOMPurify from "dompurify";
import { CheckIcon, MessageSquarePlusIcon, Trash2Icon } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApiClient } from "../api";
import { selectionAnchor, type AnnotationSelectionAnchor } from "../annotationSelection";
import type { AnnotationComment, AnnotationSession } from "../types";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { MermaidDiagram } from "./MermaidDiagram";

interface AnnotationViewProps {
  annotation: AnnotationSession;
  api: ApiClient;
  onCompleted(): void;
}

interface PendingSelection {
  anchor: AnnotationSelectionAnchor;
  left: number;
  top: number;
}

const forbiddenHTMLTags = [
  "script",
  "style",
  "iframe",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "object",
  "embed",
  "link",
  "meta",
  "img",
  "picture",
  "audio",
  "video",
  "source",
  "track",
  "svg",
  "math",
  "canvas",
];

const markdownComponents: Components = {
  pre: ({ node: _node, children, ...props }) => {
    const code = Array.isArray(children) ? children[0] : children;
    if (
      isValidElement<{ className?: string; children?: ReactNode }>(code) &&
      code.props.className === "language-mermaid"
    ) {
      return (
        <MermaidDiagram
          className="annotation-mermaid"
          source={String(code.props.children).replace(/\n$/, "")}
        />
      );
    }
    return <pre {...props}>{children}</pre>;
  },
};

export function AnnotationView({
  annotation,
  api,
  onCompleted,
}: AnnotationViewProps) {
  const readerRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLElement>(null);
  const selectionEditorRef = useRef<HTMLTextAreaElement>(null);
  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);
  const [selectionDraft, setSelectionDraft] =
    useState<AnnotationSelectionAnchor | null>(null);
  const [selectionBody, setSelectionBody] = useState("");
  const [globalBody, setGlobalBody] = useState("");
  const [comments, setComments] = useState<AnnotationComment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const commentCount = comments.length + (globalBody.trim() ? 1 : 0);
  const sanitizedHTML = useMemo(
    () => DOMPurify.sanitize(annotation.content, {
      FORBID_TAGS: forbiddenHTMLTags,
      FORBID_ATTR: [
        "style",
        "src",
        "srcset",
        "poster",
        "background",
        "xlink:href",
      ],
    }),
    [annotation.content],
  );

  useEffect(() => {
    const root = documentRef.current;
    if (!root) return;
    root.querySelectorAll("a").forEach((link) => {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    });
  }, [annotation.content, annotation.format]);

  useEffect(() => {
    if (selectionDraft) selectionEditorRef.current?.focus();
  }, [selectionDraft]);

  const captureSelection = () => {
    const root = documentRef.current;
    const reader = readerRef.current;
    const selection = window.getSelection();
    if (!root || !reader || !selection) return;
    const anchor = selectionAnchor(root, selection);
    if (!anchor) {
      setPendingSelection(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rectangles =
      typeof range.getClientRects === "function"
        ? Array.from(range.getClientRects())
        : [];
    const selectionRect =
      rectangles.at(-1) ??
      (typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : root.getBoundingClientRect());
    const readerRect = reader.getBoundingClientRect();
    const inset = 8;
    const actionWidth = 96;
    const actionHeight = 32;
    setPendingSelection({
      anchor,
      left: Math.max(
        inset,
        Math.min(
          selectionRect.right - readerRect.left + inset,
          Math.max(inset, readerRect.width - actionWidth - inset),
        ),
      ),
      top: Math.max(
        inset,
        Math.min(
          selectionRect.bottom - readerRect.top + inset,
          Math.max(inset, readerRect.height - actionHeight - inset),
        ),
      ),
    });
    setSelectionDraft(null);
    setSelectionBody("");
    setError("");
  };

  const openSelectionEditor = () => {
    if (!pendingSelection) return;
    setSelectionDraft(pendingSelection.anchor);
    setPendingSelection(null);
  };

  const addSelectionComment = () => {
    const body = selectionBody.trim();
    if (!selectionDraft || !body) return;
    setComments((current) => [
      ...current,
      {
        kind: "selection",
        body,
        quote: selectionDraft.quote,
        startOffset: selectionDraft.startOffset,
        endOffset: selectionDraft.endOffset,
      },
    ]);
    setSelectionDraft(null);
    setSelectionBody("");
    window.getSelection()?.removeAllRanges();
  };

  const sendComments = async () => {
    setSubmitting(true);
    setError("");
    try {
      const submittedComments: AnnotationComment[] = [...comments];
      const globalComment = globalBody.trim();
      if (globalComment) {
        submittedComments.push({ kind: "global", body: globalComment });
      }
      await api.completeAnnotation(annotation.id, submittedComments);
      onCompleted();
    } catch {
      setError("Comments could not be sent. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="annotation-view"
      aria-label={`Annotation: ${annotation.filename}`}
    >
      <div ref={readerRef} className="annotation-reader">
        <header className="annotation-document-header">
          <span>Review document</span>
          <strong>{annotation.filename}</strong>
        </header>
        {annotation.format === "markdown" ? (
          <article
            ref={documentRef}
            className="annotation-document annotation-markdown"
            onMouseUp={captureSelection}
            onScroll={() => setPendingSelection(null)}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {annotation.content}
            </ReactMarkdown>
          </article>
        ) : (
          <article
            ref={documentRef}
            className="annotation-document annotation-html"
            onMouseUp={captureSelection}
            onScroll={() => setPendingSelection(null)}
            dangerouslySetInnerHTML={{ __html: sanitizedHTML }}
          />
        )}
        {pendingSelection && (
          <Button
            type="button"
            size="sm"
            className="annotation-selection-action"
            style={{
              left: pendingSelection.left,
              top: pendingSelection.top,
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openSelectionEditor}
          >
            Comment
          </Button>
        )}
      </div>

      <aside className="annotation-comments" aria-label="Comments">
        <header className="annotation-comments-header">
          <span>Review notes</span>
          <strong>{commentCount}</strong>
        </header>
        <div className="annotation-comment-scroll">
          {selectionDraft && (
            <FieldGroup className="annotation-comment-form annotation-selection-form">
              <blockquote>{selectionDraft.quote}</blockquote>
              <Field data-disabled={submitting || undefined}>
                <FieldLabel htmlFor={`selection-comment-${annotation.id}`}>
                  Comment on selection
                </FieldLabel>
                <Textarea
                  ref={selectionEditorRef}
                  id={`selection-comment-${annotation.id}`}
                  aria-label="Comment on selection"
                  value={selectionBody}
                  disabled={submitting}
                  onChange={(event) => setSelectionBody(event.target.value)}
                />
              </Field>
              <Button
                type="button"
                size="sm"
                disabled={submitting || !selectionBody.trim()}
                onClick={addSelectionComment}
              >
                <MessageSquarePlusIcon data-icon="inline-start" aria-hidden="true" />
                Add selection comment
              </Button>
            </FieldGroup>
          )}

          {comments.length > 0 && (
            <ol className="annotation-comment-list" aria-label="Saved comments">
              {comments.map((comment, index) => (
                <li
                  key={`${comment.kind}-${index}`}
                  aria-label={`${comment.kind === "selection" ? "Selection" : "Global"} comment ${index + 1}`}
                >
                  <div>
                    <span>{comment.kind === "selection" ? "Selected text" : "Whole document"}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Remove comment"
                      disabled={submitting}
                      onClick={() =>
                        setComments((current) =>
                          current.filter((_, currentIndex) => currentIndex !== index),
                        )
                      }
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                  {comment.quote && <blockquote>{comment.quote}</blockquote>}
                  <p>{comment.body}</p>
                </li>
              ))}
            </ol>
          )}

          <FieldGroup className="annotation-comment-form annotation-global-form">
            <Field data-disabled={submitting || undefined}>
              <FieldLabel htmlFor={`global-comment-${annotation.id}`}>
                Global comment
              </FieldLabel>
              <FieldDescription>
                Add a note about the document as a whole.
              </FieldDescription>
              <Textarea
                id={`global-comment-${annotation.id}`}
                aria-label="Global comment"
                value={globalBody}
                disabled={submitting}
                onChange={(event) => setGlobalBody(event.target.value)}
              />
            </Field>
          </FieldGroup>
        </div>
        <footer className="annotation-submit">
          {error && <p role="alert">{error}</p>}
          <Button type="button" disabled={submitting} onClick={sendComments}>
            <CheckIcon data-icon="inline-start" aria-hidden="true" />
            {submitting ? "Sending…" : "Send comments"}
          </Button>
          <span>
            {commentCount === 0
              ? "Send with no notes to approve."
              : `${commentCount} ${commentCount === 1 ? "comment" : "comments"} ready`}
          </span>
        </footer>
      </aside>
    </section>
  );
}
