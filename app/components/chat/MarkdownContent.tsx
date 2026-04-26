import { forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Box, Divider, Link, Text } from "@shopify/polaris";

// Renders Gemini's markdown output (bold, lists, headers, links, code,
// tables) with Polaris primitives so the chat looks native to Shopify
// admin. react-markdown ignores raw HTML by default — no DOMPurify needed.
//
// Forwarded ref points at the wrapping <div> so the parent (MessageBubble's
// CopyButton) can read .innerText for plain-text copy without re-parsing
// markdown source.

type Props = {
  text: string;
};

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
            border-collapse: collapse;
            margin: 6px 0;
            font-size: 0.92em;
          }
          .copilot-markdown th,
          .copilot-markdown td {
            border: 1px solid var(--p-color-border, #e1e3e5);
            padding: 4px 8px;
            text-align: left;
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
                {children}
              </Text>
            ),
            strong: ({ children }) => (
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {children}
              </Text>
            ),
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
