import { Children, forwardRef, Fragment, isValidElement } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge, Box, Divider, Link, Text } from "@shopify/polaris";

// Renders Gemini's markdown output with Polaris primitives. Forwarded ref
// lets the parent CopyButton read `.innerText` for plain-text copy.
//
// Beyond the basics, we walk text nodes for known status tokens (ACTIVE,
// DRAFT, etc.) and replace them with Polaris <Badge> components so a chat
// listing of products visually matches the Shopify admin.

type Props = {
  text: string;
};

type BadgeTone = "success" | "info" | "warning" | "attention" | "critical";

// Standalone words that get auto-rendered as Polaris badges. Case-sensitive
// — the system prompt instructs the agent to emit these uppercase, so a
// stray "active" in prose won't accidentally badge.
const STATUS_BADGE_TONE: Record<string, BadgeTone> = {
  ACTIVE: "success",
  EXECUTED: "success",
  APPROVED: "success",
  DRAFT: "info",
  PENDING: "warning",
  ARCHIVED: "attention",
  REJECTED: "attention",
  FAILED: "critical",
};

const STATUS_TOKEN_RE = /\b(ACTIVE|EXECUTED|APPROVED|DRAFT|PENDING|ARCHIVED|REJECTED|FAILED)\b/g;

function replaceStatusTokensInString(input: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  STATUS_TOKEN_RE.lastIndex = 0;
  while ((match = STATUS_TOKEN_RE.exec(input)) !== null) {
    if (match.index > lastIndex) {
      out.push(input.slice(lastIndex, match.index));
    }
    const token = match[1];
    out.push(
      <Badge key={`${keyPrefix}-${match.index}`} tone={STATUS_BADGE_TONE[token]}>
        {token}
      </Badge>,
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < input.length) {
    out.push(input.slice(lastIndex));
  }
  return out;
}

// Recursively walk markdown children, replacing standalone status tokens in
// any leaf strings with Polaris badges. Non-string nodes (nested formatting
// like <strong>) are passed through unchanged.
function withStatusBadges(children: ReactNode, keyPrefix = "s"): ReactNode {
  if (typeof children === "string") {
    if (!STATUS_TOKEN_RE.test(children)) return children;
    return (
      <>
        {replaceStatusTokensInString(children, keyPrefix).map((part, i) => (
          <Fragment key={i}>{part}</Fragment>
        ))}
      </>
    );
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => (
      <Fragment key={i}>{withStatusBadges(child, `${keyPrefix}-${i}`)}</Fragment>
    ));
  }
  if (isValidElement(children)) {
    return children;
  }
  return children;
}

// Helper for component overrides — pulls children through the badge walker.
function badgify(children: ReactNode): ReactNode {
  return Children.map(children, (child, i) => withStatusBadges(child, `c${i}`));
}

export const MarkdownContent = forwardRef<HTMLDivElement, Props>(
  function MarkdownContent({ text }, ref) {
    return (
      <div ref={ref} className="copilot-markdown">
        <style>{`
          .copilot-markdown ul,
          .copilot-markdown ol {
            margin: 4px 0;
            padding-inline-start: 20px;
          }
          .copilot-markdown li {
            margin: 2px 0;
          }
          .copilot-markdown li > p {
            margin: 0;
          }
          .copilot-markdown p {
            margin: 0 0 6px 0;
          }
          .copilot-markdown p:last-child {
            margin-bottom: 0;
          }
          .copilot-markdown code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.9em;
            background: var(--p-color-bg-surface-secondary, #f6f6f7);
            padding: 1px 5px;
            border-radius: 4px;
          }
          .copilot-markdown pre {
            margin: 0;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.85em;
            white-space: pre-wrap;
            word-break: break-word;
          }
          .copilot-markdown pre code {
            background: transparent;
            padding: 0;
          }
          .copilot-markdown table {
            border-collapse: separate;
            border-spacing: 0;
            margin: 8px 0;
            font-size: 0.92em;
            width: 100%;
            border: 1px solid var(--p-color-border, #e1e3e5);
            border-radius: 8px;
            overflow: hidden;
          }
          .copilot-markdown thead tr {
            background: var(--p-color-bg-surface-secondary, #f6f6f7);
          }
          .copilot-markdown th {
            text-align: left;
            font-weight: 600;
            padding: 8px 12px;
            border-bottom: 1px solid var(--p-color-border, #e1e3e5);
          }
          .copilot-markdown td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--p-color-border, #e1e3e5);
            vertical-align: middle;
          }
          .copilot-markdown tbody tr:last-child td {
            border-bottom: none;
          }
          .copilot-markdown tbody tr:nth-child(even) {
            background: var(--p-color-bg-surface-secondary, #fafbfb);
          }
          .copilot-markdown blockquote {
            margin: 6px 0;
            padding: 4px 0 4px 12px;
            border-inline-start: 3px solid var(--p-color-border, #e1e3e5);
            color: var(--p-color-text-secondary, #616161);
          }
        `}</style>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => (
              <Text as="p" variant="bodyMd">
                {badgify(children)}
              </Text>
            ),
            strong: ({ children }) => (
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {badgify(children)}
              </Text>
            ),
            li: ({ children }) => <li>{badgify(children)}</li>,
            td: ({ children }) => <td>{badgify(children)}</td>,
            th: ({ children }) => <th>{badgify(children)}</th>,
            h1: ({ children }) => (
              <Text as="h3" variant="headingSm">
                {children}
              </Text>
            ),
            h2: ({ children }) => (
              <Text as="h3" variant="headingSm">
                {children}
              </Text>
            ),
            h3: ({ children }) => (
              <Text as="h3" variant="headingSm">
                {children}
              </Text>
            ),
            h4: ({ children }) => (
              <Text as="h3" variant="headingSm">
                {children}
              </Text>
            ),
            a: ({ children, href }) => (
              <Link url={href ?? "#"} target="_blank">
                {children}
              </Link>
            ),
            hr: () => <Divider />,
            blockquote: ({ children }) => <blockquote>{children}</blockquote>,
            pre: ({ children }) => (
              <Box
                padding="200"
                background="bg-surface-secondary"
                borderRadius="200"
              >
                <pre>{children}</pre>
              </Box>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  },
);
