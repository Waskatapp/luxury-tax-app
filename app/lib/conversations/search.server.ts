import prisma from "../../db.server";

// V1.7 conversation search. Keyword-based, with relevance ranking and
// snippet generation. Used by /api/conversations/search and the
// ConversationSearch UI component.
//
// Scope:
//   - Searches title (ILIKE) and message body (Message.searchText, ILIKE).
//   - Title-match-with-recent-activity beats body-only matches.
//   - Long conversations don't drown out shorter relevant ones (per-word
//     body cap at +5).
//   - Untitled conversations are excluded (matches the V1.5/V1.6 sidebar
//     behavior — those rows are mid-flight, not yet user-facing).
//   - Tenant-scoped via storeId on every query (CLAUDE.md rule #2).
//
// Out of scope (parked):
//   - Fuzzy / typo tolerance (would need pg_trgm)
//   - Stemming (would need Postgres FTS tsvector/tsquery)
//   - Match highlighting in snippet (V2 polish)
//   - Semantic / vector search (different feature)

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const FETCH_MULTIPLIER = 3;
const SNIPPET_RADIUS = 60;
const SNIPPET_MAX_LENGTH = 120;

const TITLE_HIT_PER_WORD = 10;
const TITLE_EXACT_BONUS = 50;
const BODY_HIT_PER_MSG = 1;
const BODY_HIT_CAP_PER_WORD = 5;
const FULL_COVERAGE_BONUS = 5;
const MAX_RECENCY_BOOST = 5;
const RECENCY_HALF_LIFE_DAYS = 7;

export type SearchHit = {
  conversationId: string;
  title: string;
  score: number;
  snippet: string;
  matchedIn: "title" | "body" | "both";
};

// Internal shapes — exported for unit tests.
export type ScorableConversation = {
  id: string;
  title: string;
  updatedAt: Date;
  messages: { searchText: string | null }[];
};

// Split on whitespace, lowercase, drop empty. Cap individual word length
// to defend against pathological inputs.
export function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.slice(0, 40))
    .filter((w) => w.length > 0);
}

// Count substring occurrences (case-insensitive on already-lowercased
// haystack). Use indexOf in a loop — no regex needed; safer for word
// values that contain regex meta-chars without escaping.
function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

export function scoreConversation(
  conv: ScorableConversation,
  words: string[],
  now: Date,
): { score: number; matchedIn: "title" | "body" | "both" | null } {
  if (words.length === 0) return { score: 0, matchedIn: null };

  const titleLower = conv.title.toLowerCase();
  let score = 0;
  let titleMatchedAny = false;
  let bodyMatchedAny = false;
  let allWordsCovered = true;

  for (const word of words) {
    let coveredThisWord = false;

    // Title contribution: +10 per occurrence, no upper cap (titles are
    // short so this can't run away).
    const titleHits = countOccurrences(titleLower, word);
    if (titleHits > 0) {
      score += titleHits * TITLE_HIT_PER_WORD;
      titleMatchedAny = true;
      coveredThisWord = true;
    }

    // Body contribution: count messages containing the word, +1 each,
    // capped per word so a 50-message conversation can't dominate.
    let msgsMatched = 0;
    for (const m of conv.messages) {
      if (m.searchText && countOccurrences(m.searchText, word) > 0) {
        msgsMatched += 1;
      }
    }
    if (msgsMatched > 0) {
      score += Math.min(msgsMatched, BODY_HIT_CAP_PER_WORD) * BODY_HIT_PER_MSG;
      bodyMatchedAny = true;
      coveredThisWord = true;
    }

    if (!coveredThisWord) allWordsCovered = false;
  }

  if (score === 0) return { score: 0, matchedIn: null };

  // One-time bonuses, applied after per-word loop.
  const trimmedTitleLower = titleLower.trim();
  const fullQueryLower = words.join(" ");
  if (trimmedTitleLower === fullQueryLower) {
    score += TITLE_EXACT_BONUS;
  }
  if (allWordsCovered) {
    score += FULL_COVERAGE_BONUS;
  }

  // Recency boost: linear decay from +5 (today) to 0 at 5 weeks ago.
  const ageDays =
    (now.getTime() - conv.updatedAt.getTime()) / (24 * 60 * 60 * 1000);
  const recencyBoost = Math.max(
    0,
    Math.min(MAX_RECENCY_BOOST, MAX_RECENCY_BOOST - ageDays / RECENCY_HALF_LIFE_DAYS),
  );
  score += recencyBoost;

  const matchedIn: "title" | "body" | "both" =
    titleMatchedAny && bodyMatchedAny
      ? "both"
      : titleMatchedAny
        ? "title"
        : "body";

  return { score, matchedIn };
}

// Build a ≤120-char snippet. If a query word matches the title, the
// snippet IS the title (titles are already short and self-explanatory).
// Otherwise pull ±60 chars around the first body match, trim to word
// boundaries, collapse whitespace.
export function buildSnippet(
  title: string,
  messages: { searchText: string | null }[],
  words: string[],
): string {
  if (words.length === 0) return title;

  const titleLower = title.toLowerCase();
  for (const word of words) {
    if (countOccurrences(titleLower, word) > 0) {
      return title.length > SNIPPET_MAX_LENGTH
        ? title.slice(0, SNIPPET_MAX_LENGTH) + "…"
        : title;
    }
  }

  for (const m of messages) {
    const text = m.searchText;
    if (!text) continue;
    for (const word of words) {
      const idx = text.indexOf(word);
      if (idx === -1) continue;
      return excerpt(text, idx, word.length);
    }
  }

  // No body match either (shouldn't happen for a hit, but be safe).
  return title;
}

function excerpt(haystack: string, matchIdx: number, matchLen: number): string {
  const start = Math.max(0, matchIdx - SNIPPET_RADIUS);
  const end = Math.min(haystack.length, matchIdx + matchLen + SNIPPET_RADIUS);

  // Trim to word boundary (avoid mid-word truncation).
  let trimmedStart = start;
  if (start > 0) {
    while (trimmedStart < matchIdx && /\S/.test(haystack[trimmedStart])) {
      trimmedStart += 1;
    }
    while (trimmedStart < matchIdx && /\s/.test(haystack[trimmedStart])) {
      trimmedStart += 1;
    }
  }
  let trimmedEnd = end;
  if (end < haystack.length) {
    while (trimmedEnd > matchIdx + matchLen && /\S/.test(haystack[trimmedEnd - 1])) {
      trimmedEnd -= 1;
    }
    while (trimmedEnd > matchIdx + matchLen && /\s/.test(haystack[trimmedEnd - 1])) {
      trimmedEnd -= 1;
    }
  }

  let body = haystack.slice(trimmedStart, trimmedEnd).replace(/\s+/g, " ").trim();
  if (body.length > SNIPPET_MAX_LENGTH) {
    body = body.slice(0, SNIPPET_MAX_LENGTH).trim() + "…";
  }
  if (trimmedStart > 0) body = "…" + body;
  if (trimmedEnd < haystack.length && !body.endsWith("…")) body = body + "…";
  return body;
}

// Top-level search. Reads candidate conversations in one query (with their
// relevant messages eager-loaded), scores them in memory, sorts, slices.
// Tenant-scoped at every point.
export async function searchConversations(
  storeId: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
  now: Date = new Date(),
): Promise<SearchHit[]> {
  const words = tokenize(query);
  if (words.length === 0) return [];

  const cappedLimit = Math.max(1, Math.min(MAX_LIMIT, limit));
  // Fetch a pool larger than `limit` so post-scoring re-ranking has room.
  const fetchLimit = cappedLimit * FETCH_MULTIPLIER;

  // Build OR conditions across words and search both title and any
  // message's searchText. Postgres `mode: "insensitive"` makes ILIKE.
  const wordOr = words.flatMap((word) => [
    { title: { contains: word, mode: "insensitive" as const } },
    {
      messages: {
        some: {
          searchText: { contains: word, mode: "insensitive" as const },
        },
      },
    },
  ]);

  const candidates = await prisma.conversation.findMany({
    where: {
      storeId,
      title: { not: null },
      OR: wordOr,
    },
    orderBy: { updatedAt: "desc" },
    take: fetchLimit,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      messages: {
        select: { searchText: true },
        // searchText IS NULL rows are tool-plumbing, exclude them so
        // we don't pull them across the wire just to skip in-memory.
        where: { searchText: { not: null } },
        // Cap per-conversation message scan; if a conversation has 200
        // messages we only need to know "does any contain the word"
        // for scoring (capped at +5 anyway). 100 is plenty.
        take: 100,
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const hits: SearchHit[] = [];
  for (const c of candidates) {
    if (c.title === null) continue;
    const conv: ScorableConversation = {
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      messages: c.messages,
    };
    const { score, matchedIn } = scoreConversation(conv, words, now);
    if (score === 0 || matchedIn === null) continue;
    hits.push({
      conversationId: c.id,
      title: c.title,
      score,
      snippet: buildSnippet(c.title, c.messages, words),
      matchedIn,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreak by recency: pull updatedAt from candidates lookup.
    const aConv = candidates.find((c) => c.id === a.conversationId);
    const bConv = candidates.find((c) => c.id === b.conversationId);
    return (bConv?.updatedAt.getTime() ?? 0) - (aConv?.updatedAt.getTime() ?? 0);
  });

  return hits.slice(0, cappedLimit);
}
