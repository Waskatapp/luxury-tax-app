import { useState } from "react";
import {
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

// V2.2 — inline prompt rendered when the CEO calls
// `ask_clarifying_question`. The merchant either clicks one of the
// pre-filled options or types a free-text reply; either way the answer
// is sent through the normal chat flow as the next user turn.
//
// The prompt persists as a `tool_use` block in the assistant Message's
// content, so reload re-renders this component from history. We treat
// "answered" purely as a local UI state (visually disabled buttons) —
// after the merchant replies, the next assistant Message will appear
// below this one and the merchant can scroll back and see what they
// answered. No need to mark "answered" on the server.

type Props = {
  question: string;
  options: string[];
  onAnswer: (text: string) => void | Promise<void>;
  // True once a later message has been added to the conversation — at
  // that point the merchant has already answered and we disable the
  // controls to make this read-only.
  answered: boolean;
};

export function ClarificationPrompt({
  question,
  options,
  onAnswer,
  answered,
}: Props) {
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = answered || submitting;

  const handleClick = async (text: string) => {
    if (disabled) return;
    setSubmitting(true);
    try {
      await onAnswer(text);
    } finally {
      // Reset only on free-text path; option clicks roll the conversation
      // forward and remove this prompt from focus.
      setSubmitting(false);
      setFreeText("");
    }
  };

  return (
    <Box
      padding="300"
      background="bg-surface-secondary"
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
    >
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="bodySm" tone="subdued">
            Quick question
          </Text>
        </InlineStack>
        <Text as="p" variant="bodyMd" fontWeight="medium">
          {question}
        </Text>
        {options.length > 0 ? (
          <ButtonGroup>
            {options.map((opt, i) => (
              <Button
                key={`${opt}-${i}`}
                onClick={() => handleClick(opt)}
                disabled={disabled}
              >
                {opt}
              </Button>
            ))}
          </ButtonGroup>
        ) : null}
        <BlockStack gap="100">
          <TextField
            label={options.length > 0 ? "Or type your own answer" : "Your answer"}
            labelHidden={options.length === 0}
            placeholder={
              options.length > 0
                ? "Or describe what you mean…"
                : "Type your answer…"
            }
            value={freeText}
            onChange={setFreeText}
            disabled={disabled}
            autoComplete="off"
          />
          <InlineStack align="end">
            <Button
              variant="primary"
              onClick={() => handleClick(freeText.trim())}
              disabled={disabled || freeText.trim().length === 0}
            >
              Send
            </Button>
          </InlineStack>
        </BlockStack>
      </BlockStack>
    </Box>
  );
}
