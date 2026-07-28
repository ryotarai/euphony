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

const secondRunningSession: Session = {
  id: "session-2",
  name: "Claude",
  state: "running",
  createdAt: "2026-07-28T00:01:00Z",
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

test("consumes a token from the URL without leaving it in browser history", async () => {
  history.replaceState(null, "", "/?token=development-token");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse([]));

  render(<App />);

  expect(await screen.findByRole("button", { name: "Start a terminal" })).toBeVisible();
  expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  expect(window.location.search).toBe("");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer development-token" }),
    }),
  );
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

test("creates a terminal without asking for a name, selects it, and deletes it", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([]))
    .mockImplementationOnce(() => jsonResponse(runningSession, 201))
    .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));

  const user = userEvent.setup();
  render(<App initialToken="valid-token" renderTerminal={(session) => <div>{session.name}</div>} />);

  await user.click(await screen.findByRole("button", { name: "Start a terminal" }));

  expect(screen.queryByLabelText("Terminal name")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Terminal" }),
    }),
  );
  expect(await screen.findByRole("button", { name: "Select Codex" })).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Delete Codex" }));

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Delete Codex" })).not.toBeInTheDocument();
  });
});

test("restores the selected session from the URL and follows browser navigation", async () => {
  history.replaceState(null, "", "/?session=session-2");
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession, secondRunningSession]),
  );
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  expect(screen.queryByLabelText("Codex terminal pane")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Select Codex" }));
  expect(new URLSearchParams(window.location.search).get("session")).toBe("session-1");
  expect(await screen.findByLabelText("Codex terminal pane")).toBeVisible();

  history.pushState(null, "", "/?session=session-2");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
});

test("creates a new terminal for a vertical split and stores both panes in the URL", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock
    .mockImplementationOnce(() => jsonResponse([runningSession]))
    .mockImplementationOnce(() => jsonResponse(secondRunningSession, 201));
  const user = userEvent.setup();
  render(
    <App
      initialToken="valid-token"
      renderTerminal={(session) => <div aria-label={`${session.name} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("Codex terminal pane");
  await user.click(screen.getByRole("button", { name: "Split vertically" }));

  expect(screen.getByLabelText("Codex terminal pane")).toBeVisible();
  expect(await screen.findByLabelText("Claude terminal pane")).toBeVisible();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Terminal" }),
    }),
  );
  const parameters = new URLSearchParams(window.location.search);
  expect(parameters.get("session")).toBe("session-1");
  expect(parameters.get("split")).toBe("session-2");
  expect(parameters.get("focus")).toBe("session-2");

  fireEvent.mouseDown(screen.getByLabelText("Codex pane"));
  expect(screen.getByLabelText("Codex pane")).toHaveAttribute("data-active", "true");
  expect(new URLSearchParams(window.location.search).get("focus")).toBe("session-1");

  history.pushState(null, "", "/?session=session-1&split=session-2&focus=session-2");
  fireEvent(window, new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(screen.getByLabelText("Claude pane")).toHaveAttribute("data-active", "true");
  });

  await user.click(screen.getByRole("button", { name: "Close split" }));
  expect(screen.queryByLabelText("Claude terminal pane")).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).has("split")).toBe(false);
});
