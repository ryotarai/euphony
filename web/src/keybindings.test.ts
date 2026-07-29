import { isEditableTarget, matchesPrefix, normalizePrefix } from "./keybindings";

test("matches the default Ctrl+B prefix case-insensitively", () => {
  expect(matchesPrefix(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }), "Ctrl+B")).toBe(true);
  expect(matchesPrefix(new KeyboardEvent("keydown", { key: "B", ctrlKey: true }), "ctrl+b")).toBe(true);
  expect(matchesPrefix(new KeyboardEvent("keydown", { key: "b" }), "Ctrl+B")).toBe(false);
});

test("matches configurable modifier combinations exactly", () => {
  expect(
    matchesPrefix(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, shiftKey: true }),
      "Meta+Shift+K",
    ),
  ).toBe(true);
  expect(
    matchesPrefix(new KeyboardEvent("keydown", { key: "k", metaKey: true }), "Meta+Shift+K"),
  ).toBe(false);
  expect(normalizePrefix(" control + a ")).toBe("Ctrl+A");
});

test("detects editable keyboard targets", () => {
  const input = document.createElement("input");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  expect(isEditableTarget(input)).toBe(true);
  expect(isEditableTarget(editor)).toBe(true);
  expect(isEditableTarget(document.createElement("button"))).toBe(false);
});
