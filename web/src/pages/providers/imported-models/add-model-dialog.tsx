// Add-upstream-model dialog. Was an inline bar pinned above the table; moved
// into a dialog off an "Add upstream model" header action (beside "Import
// from upstream") so the table itself only ever shows the table + its
// search, not a permanent input form.

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function AddModelDialog({
  onAdd,
  onClose,
}: {
  onAdd: (raw: string) => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState("");
  const submit = () => {
    if (!val.trim()) return;
    onAdd(val);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add upstream model</DialogTitle>
          <DialogDescription>
            One or more upstream model IDs, separated by commas or new lines.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={"gpt-4o-mini\nclaude-opus-4-6, gpt-5"}
          className="h-32 font-mono"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!val.trim()}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
