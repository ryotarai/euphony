import { SearchIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { normalizeSessionFilter } from "../sessionPresentation";

interface SessionFilterProps {
  value: string;
  totalCount: number;
  visibleCount: number;
  onChange(value: string): void;
}

export function SessionFilter({
  value,
  totalCount,
  visibleCount,
  onChange,
}: SessionFilterProps) {
  const active = normalizeSessionFilter(value) !== "";
  const count = active
    ? `${visibleCount} of ${totalCount} ${totalCount === 1 ? "session" : "sessions"}`
    : `${totalCount} ${totalCount === 1 ? "session" : "sessions"}`;

  return (
    <div className="session-filter">
      <SearchIcon aria-hidden="true" className="session-filter-icon" />
      <label className="sr-only" htmlFor="session-filter-input">Filter sessions</label>
      <Input
        id="session-filter-input"
        type="search"
        role="searchbox"
        aria-label="Filter sessions"
        placeholder="Filter sessions…"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          className="session-filter-clear"
          aria-label="Clear session filter"
          title="Clear session filter"
          onClick={() => onChange("")}
        >
          <XIcon aria-hidden="true" />
        </button>
      )}
      <span className="session-filter-count" aria-live="polite">{count}</span>
    </div>
  );
}
