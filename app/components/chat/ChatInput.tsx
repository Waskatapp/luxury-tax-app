import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ActionList,
  Button,
  InlineStack,
  Popover,
  TextField,
} from "@shopify/polaris";

import {
  filterSlashCommands,
  parseSlashCommand,
  shouldShowPicker,
  type SlashCommand,
} from "../../lib/agent/slash-commands";

type Props = {
  disabled?: boolean;
  onSend: (text: string) => void;
};

export function ChatInput({ disabled, onSend }: Props) {
  const [value, setValue] = useState("");
  // Manual popover toggle. Only open when (a) the input matches the
  // shouldShowPicker rule AND (b) the merchant hasn't dismissed it via
  // Escape for the current `/` they're typing.
  const [pickerOpen, setPickerOpen] = useState(false);
  const dismissedRef = useRef<string | null>(null);

  // V2.4 — slash-command expansion. We check this on submit and replace
  // the sent text with the expanded prompt. The merchant's bubble shows
  // the EXPANDED version (clearer than `/audit` two days later when they
  // re-read the conversation).
  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    const parsed = parseSlashCommand(trimmed);
    const toSend = parsed ? parsed.expanded : trimmed;
    onSend(toSend);
    setValue("");
    setPickerOpen(false);
    dismissedRef.current = null;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  // Open the picker when the merchant starts typing `/`. Re-open if they
  // delete back to `/` after dismissing.
  useEffect(() => {
    if (disabled) {
      setPickerOpen(false);
      return;
    }
    const should = shouldShowPicker(value);
    if (!should) {
      setPickerOpen(false);
      dismissedRef.current = null;
      return;
    }
    // Don't re-open if the merchant explicitly dismissed THIS particular
    // slash invocation (Escape). The dismissedRef stores the value at
    // dismiss time so further typing reopens.
    if (dismissedRef.current === value) return;
    setPickerOpen(true);
  }, [value, disabled]);

  const filtered = useMemo<SlashCommand[]>(
    () => filterSlashCommands(value),
    [value],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Escape dismisses the picker without sending.
    if (event.key === "Escape" && pickerOpen) {
      setPickerOpen(false);
      dismissedRef.current = value;
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  function selectCommand(name: string) {
    // Clicking a command fills `/<name> ` (trailing space) so the
    // merchant can immediately type args. Picker auto-closes because
    // the trailing space makes shouldShowPicker return false.
    setValue("/" + name + " ");
    setPickerOpen(false);
    dismissedRef.current = null;
  }

  const canSend = !disabled && value.trim().length > 0;

  // Build ActionList items. Description shows the arg hint so power
  // users know what to type after the command name.
  const actionItems = filtered.map((c) => ({
    content: "/" + c.name,
    helpText: `${c.description} — ${c.argHint}`,
    onAction: () => selectCommand(c.name),
  }));

  return (
    <form onSubmit={handleSubmit}>
      <InlineStack gap="200" blockAlign="end" wrap={false}>
        <div style={{ flex: 1 }} onKeyDown={handleKeyDown}>
          <Popover
            active={pickerOpen && actionItems.length > 0}
            preferredAlignment="left"
            preferredPosition="above"
            autofocusTarget="none"
            onClose={() => {
              setPickerOpen(false);
              dismissedRef.current = value;
            }}
            activator={
              <TextField
                label=""
                labelHidden
                placeholder='Message your Copilot — type "/" for shortcuts'
                multiline={2}
                autoComplete="off"
                value={value}
                onChange={setValue}
                disabled={disabled}
              />
            }
          >
            <ActionList
              actionRole="menuitem"
              sections={[
                {
                  title: "Slash commands",
                  items: actionItems,
                },
              ]}
            />
          </Popover>
        </div>
        <Button submit variant="primary" disabled={!canSend}>
          Send
        </Button>
      </InlineStack>
    </form>
  );
}
