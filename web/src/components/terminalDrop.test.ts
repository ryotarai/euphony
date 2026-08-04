import { terminalInputFromPaths, terminalInputFromURIList } from "./terminalDrop";

test("quotes absolute paths received from the macOS drop bridge", () => {
  expect(
    terminalInputFromPaths([
      "/tmp/first file.txt",
      "/tmp/O'Brien.txt",
      "relative.txt",
    ]),
  ).toBe("'/tmp/first file.txt' '/tmp/O'\\''Brien.txt'");
});

test.each([
  {
    name: "quotes a local path containing spaces",
    uriList: "file:///Users/me/My%20File.txt",
    expected: "'/Users/me/My File.txt'",
  },
  {
    name: "decodes UTF-8 path segments",
    uriList: "file:///Users/me/%E6%9B%B8%E9%A1%9E",
    expected: "'/Users/me/書類'",
  },
  {
    name: "escapes an embedded single quote",
    uriList: "file:///tmp/O%27Brien.txt",
    expected: "'/tmp/O'\\''Brien.txt'",
  },
  {
    name: "preserves the order of multiple paths and ignores comments",
    uriList: [
      "# Finder file URLs",
      "file:///tmp/first.txt",
      "file:///tmp/second%20file.txt",
    ].join("\r\n"),
    expected: "'/tmp/first.txt' '/tmp/second file.txt'",
  },
  {
    name: "accepts localhost file URLs",
    uriList: "file://localhost/tmp/local.txt",
    expected: "'/tmp/local.txt'",
  },
])("$name", ({ uriList, expected }) => {
  expect(terminalInputFromURIList(uriList)).toBe(expected);
});

test.each([
  ["an empty list", ""],
  ["comments only", "# no files\n# here"],
  ["an HTTP URL", "https://example.com/file.txt"],
  ["a remote file host", "file://server/share/file.txt"],
  ["a relative file URL", "file:relative.txt"],
  ["a malformed escape", "file:///tmp/%ZZ"],
])("ignores %s", (_name, uriList) => {
  expect(terminalInputFromURIList(uriList)).toBeNull();
});
