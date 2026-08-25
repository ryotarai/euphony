import { replacementSession } from "./sessionUtils";
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

test("does not choose an arbitrary first session when the removed target is stale", () => {
  const remaining = [session("first"), session("second")];

  expect(replacementSession([session("previous")], "removed", remaining)).toBeUndefined();
});
