function quotePOSIXPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function terminalInputFromPaths(paths: readonly string[]): string | null {
  const absolutePaths = paths.filter(
    (path) => path.startsWith("/") && !path.includes("\0"),
  );
  return absolutePaths.length > 0
    ? absolutePaths.map(quotePOSIXPath).join(" ")
    : null;
}

export function terminalInputFromURIList(value: string): string | null {
  const paths = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      if (!line.startsWith("file://")) return [];
      try {
        const url = new URL(line);
        if (
          url.protocol !== "file:" ||
          (url.hostname !== "" && url.hostname !== "localhost") ||
          !url.pathname.startsWith("/")
        ) {
          return [];
        }
        return [decodeURIComponent(url.pathname)];
      } catch {
        return [];
      }
    });

  return terminalInputFromPaths(paths);
}
