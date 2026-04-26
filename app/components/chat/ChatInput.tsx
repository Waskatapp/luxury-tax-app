import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, InlineStack, TextField } from "@shopify/polaris";

type Props = {
  disabled?: boolean;
  onSend: (text: string) => void;
};

export function ChatInput({ disabled, onSend }: Props) {
  const [value, setValue] = useState("");

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  // Enter alone → send. Shift+Enter → newline (the textarea's default).
  // We attach onKeyDown to the wrapper div because Polaris TextField doesn't
  // expose onKeyDown as a prop; keydown events bubble from the inner textarea.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // IME composition (CJK input methods) — let the composition finish.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  const canSend = !disabled && value.trim().length > 0;

  return (
    <form onSubmit={handleSubmit}>
      <InlineStack gap="200" blockAlign="end" wrap={false}>
        <div style={{ flex: 1 }} onKeyDown={handleKeyDown}>
          <TextField
            label=""
            labelHidden
            placeholder="Message your Copilot — Enter to send, Shift+Enter for a new line"
            multiline={2}
            autoComplete="off"
            value={value}
            onChange={setValue}
            disabled={disabled}
          />
        </div>
        <Button submit variant="primary" disabled={!canSend}>
          Send
        </Button>
      </InlineStack>
    </form>
  );
}
