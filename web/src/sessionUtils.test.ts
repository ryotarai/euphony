import {
  replacementSession,
  replacementSessionForClose,
} from "./sessionUtils";
import type { Session } from "./types";

function session(id: string): Session {
  return {
    id,
    name: id,
    state: "running",
    cwd: "/workspace",
    createdAt: "2026-08-25T00:00:00Z",
  };
}

test("keeps the first fallback when asynchronous disappearance has no prior survivor", () => {
  const remaining = [session("first"), session("second")];

  expect(replacementSession([session("previous")], "removed", remaining)).toBe(
    remaining[0],
  );
});

test("does not choose an arbitrary first session for a stale explicit close", () => {
  const remaining = [session("first"), session("second")];

  expect(
    replacementSessionForClose([session("previous")], "removed", remaining),
  ).toBeUndefined();
});
