import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { CheckIcon, MessageSquarePlusIcon, Trash2Icon } from "lucide-react";
import ReactMarkdown from "react-markdown";
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

interface AnnotationViewProps {
  annotation: AnnotationSession;
  api: ApiClient;
  onCompleted(): void;
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
];

export function AnnotationView({
  annotation,
  api,
  onCompleted,
}: AnnotationViewProps) {
  const documentRef = useRef<HTMLElement>(null);
  const selectionEditorRef = useRef<HTMLTextAreaElement>(null);
  const [selectionDraft, setSelectionDraft] =
    useState<AnnotationSelectionAnchor | null>(null);
  const [selectionBody, setSelectionBody] = useState("");
  const [globalBody, setGlobalBody] = useState("");
  const [comments, setComments] = useState<AnnotationComment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const sanitizedHTML = useMemo(
    () => DOMPurify.sanitize(annotation.content, {
      FORBID_TAGS: forbiddenHTMLTags,
      FORBID_ATTR: ["style"],
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
    const selection = window.getSelection();
    if (!root || !selection) return;
    const anchor = selectionAnchor(root, selection);
    if (!anchor) return;
    setSelectionDraft(anchor);
    setSelectionBody("");
    setError("");
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

  const addGlobalComment = () => {
    const body = globalBody.trim();
    if (!body) return;
    setComments((current) => [...current, { kind: "global", body }]);
    setGlobalBody("");
  };

  const sendComments = async () => {
    setSubmitting(true);
    setError("");
    try {
      await api.completeAnnotation(annotation.id, comments);
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
      <div className="annotation-reader">
        <header className="annotation-document-header">
          <span>Review document</span>
          <strong>{annotation.filename}</strong>
        </header>
        {annotation.format === "markdown" ? (
          <article
            ref={documentRef}
            className="annotation-document annotation-markdown"
            onMouseUp={captureSelection}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {annotation.content}
            </ReactMarkdown>
          </article>
        ) : (
          <article
            ref={documentRef}
            className="annotation-document annotation-html"
            onMouseUp={captureSelection}
            dangerouslySetInnerHTML={{ __html: sanitizedHTML }}
          />
        )}
      </div>

      <aside className="annotation-comments" aria-label="Comments">
        <header className="annotation-comments-header">
          <span>Review notes</span>
          <strong>{comments.length}</strong>
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting || !globalBody.trim()}
              onClick={addGlobalComment}
            >
              <MessageSquarePlusIcon data-icon="inline-start" aria-hidden="true" />
              Add global comment
            </Button>
          </FieldGroup>
        </div>
        <footer className="annotation-submit">
          {error && <p role="alert">{error}</p>}
          <Button type="button" disabled={submitting} onClick={sendComments}>
            <CheckIcon data-icon="inline-start" aria-hidden="true" />
            {submitting ? "Sending…" : "Send comments"}
          </Button>
          <span>
            {comments.length === 0
              ? "Send with no notes to approve."
              : `${comments.length} ${comments.length === 1 ? "comment" : "comments"} ready`}
          </span>
        </footer>
      </aside>
    </section>
  );
}
