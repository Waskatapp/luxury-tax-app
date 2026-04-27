import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  BlockStack,
  Box,
  Icon,
  InlineStack,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { useDebouncedValue } from "../../hooks/useDebouncedValue";

// Conversation search bar with autocomplete dropdown. Lives at the top
// of ConversationSidebar. Debounces the input 200ms, fires
// /api/conversations/search, renders a Popover-style dropdown of hits
// ranked by relevance.
//
// Keyboard:
//   ↓ / ↑    navigate hits
//   Enter   select highlighted hit (or first if none highlighted)
//   Esc     close dropdown + clear input
//   ⌘K / Ctrl+K  focus search bar from anywhere on the page

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

type Hit = {
  conversationId: string;
  title: string;
  score: number;
  snippet: string;
  matchedIn: "title" | "body" | "both";
};

type Props = {
  onSelect: (conversationId: string) => void;
};

export function ConversationSearch({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [open, setOpen] = useState(false);
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);

  // Monotonic request id — used to drop stale fetch responses if a
  // newer query has been issued by the time an older one resolves.
  const requestIdRef = useRef(0);

  const fieldId = useId();
  const listboxId = `${fieldId}-listbox`;

  // Fetch hits whenever the debounced query changes.
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setHits([]);
      setLoading(false);
      return;
    }

    const myId = ++requestIdRef.current;
    setLoading(true);

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/conversations/search?q=${encodeURIComponent(trimmed)}&limit=8`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (myId !== requestIdRef.current) return; // a newer request is in flight
        if (!res.ok) {
          setHits([]);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { hits: Hit[] };
        if (myId !== requestIdRef.current) return;
        setHits(data.hits ?? []);
        setHighlighted(0);
        setLoading(false);
      } catch {
        if (myId === requestIdRef.current) {
          setHits([]);
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [debouncedQuery]);

  // ⌘K / Ctrl+K hotkey to focus the search bar from anywhere on the page.
  // We can't easily get a ref to Polaris's underlying input, so locate
  // it by id (Polaris auto-applies the id we pass to the TextField).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        const el = document.getElementById(fieldId);
        if (el instanceof HTMLInputElement) el.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fieldId]);

  const selectHit = useCallback(
    (hit: Hit) => {
      onSelect(hit.conversationId);
      setQuery("");
      setHits([]);
      setOpen(false);
      requestIdRef.current += 1; // invalidate any in-flight request
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!open || hits.length === 0) {
        if (e.key === "Escape") {
          setQuery("");
          setOpen(false);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => Math.min(hits.length - 1, h + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => Math.max(0, h - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = hits[highlighted] ?? hits[0];
        if (hit) selectHit(hit);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setQuery("");
        setOpen(false);
      }
    },
    [open, hits, highlighted, selectHit],
  );

  // Show dropdown only after typing past the minimum threshold AND
  // (loading or having results, or an explicit "no matches").
  const trimmed = debouncedQuery.trim();
  const showDropdown =
    open &&
    trimmed.length >= MIN_QUERY_LENGTH;

  return (
    <div
      onKeyDown={handleKeyDown}
      style={{ position: "relative" }}
    >
      <TextField
        id={fieldId}
        label="Search conversations"
        labelHidden
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Don't blur-close immediately — clicking a hit needs the click
        // to register first. We instead close on Esc or after selecting.
        autoComplete="off"
        placeholder="Search conversations"
        prefix={<Icon source={SearchIcon} tone="subdued" />}
        suffix={loading ? <Spinner size="small" accessibilityLabel="Searching" /> : null}
        clearButton
        onClearButtonClick={() => {
          setQuery("");
          setHits([]);
          setOpen(false);
        }}
        ariaControls={listboxId}
        ariaExpanded={showDropdown}
        ariaActiveDescendant={
          showDropdown && hits[highlighted]
            ? `${listboxId}-${hits[highlighted].conversationId}`
            : undefined
        }
        ariaAutocomplete="list"
      />

      {showDropdown ? (
        <div
          id={listboxId}
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            zIndex: 20,
            background: "var(--p-color-bg-surface)",
            border: "1px solid var(--p-color-border)",
            borderRadius: "var(--p-border-radius-200)",
            boxShadow: "var(--p-shadow-300)",
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {hits.length === 0 ? (
            <Box padding="300">
              <Text as="p" variant="bodySm" tone="subdued">
                {loading ? "Searching…" : "No matches"}
              </Text>
            </Box>
          ) : (
            hits.map((hit, idx) => {
              const isHighlighted = idx === highlighted;
              return (
                <div
                  key={hit.conversationId}
                  id={`${listboxId}-${hit.conversationId}`}
                  role="option"
                  aria-selected={isHighlighted}
                  onMouseEnter={() => setHighlighted(idx)}
                  // onMouseDown — fire BEFORE the input's blur so we
                  // don't lose the click target.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectHit(hit);
                  }}
                  style={{
                    padding: "8px 12px",
                    cursor: "pointer",
                    background: isHighlighted
                      ? "var(--p-color-bg-surface-hover)"
                      : "transparent",
                    borderBottom: "1px solid var(--p-color-border-secondary)",
                  }}
                >
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" fontWeight="medium" truncate>
                      {hit.title}
                    </Text>
                    {hit.matchedIn !== "title" &&
                    hit.snippet.trim().toLowerCase() !==
                      hit.title.trim().toLowerCase() ? (
                      <InlineStack gap="100" blockAlign="center">
                        <Text as="p" variant="bodySm" tone="subdued" truncate>
                          {hit.snippet}
                        </Text>
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
