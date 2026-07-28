import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import type { Session } from "./types";

const runningSession: Session = {
  id: "session-1",
  name: "Codex",
  state: "running",
  createdAt: "2026-07-28T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

test("stores a valid token in sessionStorage and shows the empty workspace", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse([]));
  const user = userEvent.setup();
  render(<App />);

  await user.type(screen.getByLabelText("Access token"), "valid-token");
  await user.click(screen.getByRole("button", { name: "Open Euphony" }));

  expect(await screen.findByRole("button", { name: "Start a terminal" })).toBeVisible();
  expect(sessionStorage.getItem("euphony.token")).toBe("valid-token");
});

test("returns to token entry after an invalid token", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse({ code: "unauthorized", message: "A valid access token is required." }, 401),
  );
  const user = userEvent.setup();
  render(<App />);

  await user.type(screen.getByLabelText("Access token"), "invalid-token");
  await user.click(screen.getByRole("button", { name: "Open Euphony" }));

  expect(await screen.findByText("That token was not accepted.")).toBeVisible();
  expect(sessionStorage.getItem("euphony.token")).toBeNull();
});

test("creates, selects, and deletes a session", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse(runningSession, 201))
    .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));

  const user = userEvent.setup();
  render(<App initialToken="valid-token" renderTerminal={(session) => <div>{session.name}</div>} />);

  await user.click(await screen.findByRole("button", { name: "Start a terminal" }));
  const nameInput = screen.getByLabelText("Terminal name");
  await user.clear(nameInput);
  await user.type(nameInput, "Codex");
  await user.click(screen.getByRole("button", { name: "Start terminal" }));

  expect(await screen.findByRole("button", { name: "Select Codex" })).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Delete Codex" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Delete Codex" })).not.toBeInTheDocument();
  });
});
