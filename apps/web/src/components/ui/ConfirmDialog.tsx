import { type ReactNode } from "react";

import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  /** Body slot for extra detail (e.g. a list of blocking references). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Ink-on-red confirm for irreversible actions. */
  destructive?: boolean;
  /** Spinner + disabled confirm while the mutation runs. */
  loading?: boolean;
  /**
   * Forced-choice blocker: hides the confirm action entirely (the dialog
   * just explains why something can't be done) and renders cancel as "Got
   * it".
   */
  blocker?: boolean;
}

/**
 * Confirmation dialog on the glass Modal. Destructive confirms get the
 * ink-on-red treatment; a `blocker` variant explains why an action is
 * impossible with a single acknowledge button.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  loading = false,
  blocker = false,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      maxWidthClassName="max-w-md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            {cancelLabel ?? (blocker ? "Got it" : "Cancel")}
          </Button>
          {blocker ? null : (
            <Button
              size="sm"
              loading={loading}
              onClick={onConfirm}
              className={
                destructive
                  ? "bg-err text-white hover:shadow-[0_5px_16px_rgba(220,38,38,0.32)]"
                  : undefined
              }
            >
              {confirmLabel ?? (destructive ? "Delete" : "Confirm")}
            </Button>
          )}
        </>
      }
    >
      {children ? <div className="pb-1">{children}</div> : <div className="pb-1" />}
    </Modal>
  );
}
