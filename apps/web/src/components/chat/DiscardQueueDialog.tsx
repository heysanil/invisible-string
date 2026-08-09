/**
 * Shared confirm for every path that would drop a non-empty message queue:
 * an in-pane session switch, a route navigation, and "New chat".
 *
 * It self-closes when the count reaches zero. A flush can land while the
 * dialog is open, and offering to discard messages that have already been
 * sent is worse than not asking at all.
 */
import { useEffect } from "react";

import { ConfirmDialog } from "../ui/ConfirmDialog";

export interface DiscardQueueDialogProps {
  open: boolean;
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}

export function DiscardQueueDialog({
  open,
  count,
  onClose,
  onConfirm,
}: DiscardQueueDialogProps) {
  useEffect(() => {
    if (open && count === 0) onClose();
  }, [open, count, onClose]);

  const noun = count === 1 ? "message" : "messages";
  return (
    <ConfirmDialog
      open={open && count > 0}
      onClose={onClose}
      onConfirm={onConfirm}
      destructive
      title={`Discard ${count} queued ${noun}?`}
      description={`${count === 1 ? "It has" : "They have"} not been sent yet. Leaving this conversation drops ${count === 1 ? "it" : "them"}.`}
      confirmLabel="Discard"
      cancelLabel="Stay here"
    />
  );
}
