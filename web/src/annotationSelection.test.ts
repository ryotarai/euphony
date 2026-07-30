import { selectionAnchor } from "./annotationSelection";

test("anchors a selection across nested rendered elements", () => {
  const root = document.createElement("article");
  root.innerHTML = "<p>Alpha <strong>bold</strong> beta</p>";
  document.body.append(root);
  const first = root.querySelector("p")?.firstChild;
  const last = root.querySelector("p")?.lastChild;
  if (!first || !last) throw new Error("missing text fixture");
  const range = document.createRange();
  range.setStart(first, 2);
  range.setEnd(last, 3);
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unsupported");
  selection.removeAllRanges();
  selection.addRange(range);

  expect(selectionAnchor(root, selection)).toEqual({
    quote: "pha bold be",
    startOffset: 2,
    endOffset: 13,
  });
});

test("trims surrounding whitespace and adjusts rendered offsets", () => {
  const root = document.createElement("article");
  root.textContent = "Before   selected text   after";
  document.body.append(root);
  const text = root.firstChild;
  if (!text) throw new Error("missing text fixture");
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 25);
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unsupported");
  selection.removeAllRanges();
  selection.addRange(range);

  expect(selectionAnchor(root, selection)).toEqual({
    quote: "selected text",
    startOffset: 9,
    endOffset: 22,
  });
});

test("rejects collapsed selections and selections outside the document", () => {
  const root = document.createElement("article");
  root.textContent = "Inside";
  const outside = document.createElement("p");
  outside.textContent = "Outside";
  document.body.append(root, outside);
  const selection = window.getSelection();
  if (!selection || !outside.firstChild) throw new Error("selection unsupported");
  const range = document.createRange();
  range.selectNodeContents(outside);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selectionAnchor(root, selection)).toBeNull();

  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selectionAnchor(root, selection)).toBeNull();
});
