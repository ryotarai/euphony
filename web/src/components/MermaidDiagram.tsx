import { useEffect, useId, useState } from "react";
import type { Mermaid } from "mermaid";

type DiagramState =
  | { status: "loading"; source: string }
  | { status: "rendered"; source: string; svg: string }
  | { status: "failed"; source: string };

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "dark",
          fontFamily: '"Geist Variable", sans-serif',
          themeVariables: {
            background: "#0B0D0F",
            primaryColor: "#171717",
            primaryBorderColor: "#525252",
            primaryTextColor: "#F5F5F5",
            secondaryColor: "#0B0D0F",
            secondaryBorderColor: "#343434",
            secondaryTextColor: "#DEDEDE",
            tertiaryColor: "#050505",
            tertiaryBorderColor: "#262626",
            tertiaryTextColor: "#DEDEDE",
            lineColor: "#8A8A8A",
            textColor: "#DEDEDE",
          },
        });
        return mermaid;
      })
      .catch((error: unknown) => {
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

interface MermaidDiagramProps {
  source: string;
  className?: string;
}

export function MermaidDiagram({ source, className }: MermaidDiagramProps) {
  const reactId = useId();
  const diagramId = `agent-log-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [state, setState] = useState<DiagramState>({ status: "loading", source });
  const currentState: DiagramState = state.source === source
    ? state
    : { status: "loading", source };

  useEffect(() => {
    let current = true;
    setState({ status: "loading", source });

    void loadMermaid()
      .then((mermaid) => mermaid.render(diagramId, source))
      .then(({ svg }) => {
        if (current) setState({ status: "rendered", source, svg });
      })
      .catch(() => {
        if (current) setState({ status: "failed", source });
      });

    return () => {
      current = false;
    };
  }, [diagramId, source]);

  if (currentState.status === "rendered") {
    return (
      <figure
        className={["markdown-mermaid", className].filter(Boolean).join(" ")}
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: currentState.svg }}
      />
    );
  }

  return (
    <figure
      className={["markdown-mermaid", className].filter(Boolean).join(" ")}
      aria-label="Mermaid diagram"
      aria-busy={currentState.status === "loading"}
    >
      <pre className="markdown-mermaid-source">
        <code>{source}</code>
      </pre>
      {currentState.status === "failed" && (
        <figcaption className="markdown-mermaid-error">
          Diagram could not be rendered.
        </figcaption>
      )}
    </figure>
  );
}
