export interface AnnotationSelectionAnchor {
  quote: string;
  startOffset: number;
  endOffset: number;
}

function inside(root: HTMLElement, node: Node): boolean {
  return node === root || root.contains(node);
}

export function selectionAnchor(
  root: HTMLElement,
  selection: Selection,
): AnnotationSelectionAnchor | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!inside(root, range.startContainer) || !inside(root, range.endContainer)) {
    return null;
  }
  const selected = range.toString();
  const leading = selected.match(/^\s*/u)?.[0].length ?? 0;
  const trailing = selected.match(/\s*$/u)?.[0].length ?? 0;
  const quote = selected.slice(leading, selected.length - trailing);
  if (!quote) return null;

  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const startOffset = prefix.toString().length + leading;
  return {
    quote,
    startOffset,
    endOffset: startOffset + quote.length,
  };
}
