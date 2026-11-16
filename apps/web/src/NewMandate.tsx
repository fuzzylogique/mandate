import type { PaymentWorkspace } from "@mandate/shared";
import { CreateMandateForm } from "./CreateMandateForm.tsx";
import { Dialog } from "./Dialog.tsx";

export function NewMandate({ workspace, onDone, onClose }: { workspace: PaymentWorkspace; onDone: () => Promise<void>; onClose: () => void }) {
  return <Dialog title="New mandate" onClose={onClose}><CreateMandateForm workspace={workspace} onDone={onDone} onClose={onClose} /></Dialog>;
}
