const modifierNames = new Map([
  ["control", "Ctrl"],
  ["ctrl", "Ctrl"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
  ["meta", "Meta"],
  ["cmd", "Meta"],
  ["command", "Meta"],
]);

export function normalizePrefix(value: string): string {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return value.trim();
  return parts
    .map((part, index) => {
      const modifier = modifierNames.get(part.toLowerCase());
      if (index < parts.length - 1 && modifier) return modifier;
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

export function matchesPrefix(event: KeyboardEvent, prefix: string): boolean {
  const parts = normalizePrefix(prefix).split("+");
  const key = parts.at(-1)?.toLowerCase();
  const modifiers = new Set(parts.slice(0, -1));
  return (
    Boolean(key) &&
    event.key.toLowerCase() === key &&
    event.ctrlKey === modifiers.has("Ctrl") &&
    event.altKey === modifiers.has("Alt") &&
    event.shiftKey === modifiers.has("Shift") &&
    event.metaKey === modifiers.has("Meta")
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".terminal-host")) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    target.contentEditable === "true" ||
    target.closest("[contenteditable='true']") !== null
  );
}
