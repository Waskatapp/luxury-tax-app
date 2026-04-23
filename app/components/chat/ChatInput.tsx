import { useState, type FormEvent } from "react";
import { Button, InlineStack, TextField } from "@shopify/polaris";

type Props = {
  disabled?: boolean;
  onSend: (text: string) => void;
};

export function ChatInput({ disabled, onSend }: Props) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  const canSend = !disabled && value.trim().length > 0;

  return (
    <form onSubmit={handleSubmit}>
      <InlineStack gap="200" blockAlign="end" wrap={false}>
        <div style={{ flex: 1 }}>
          <TextField
            label=""
            labelHidden
            placeholder="Message your Copilot"
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
