import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { User } from "@/lib/types";
import {
  PageHeader,
  TableSkeleton,
  EmptyState,
  Field,
} from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function Users() {
  const [items, setItems] = useState<User[] | null>(null);
  const [editing, setEditing] = useState<User | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.listUsers().then(setItems).catch(toast.error);
  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <PageHeader
        title="Users"
        desc="Group API keys by owner to track usage per user"
        meta={<Badge variant="secondary">{items?.length ?? 0} total</Badge>}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            New User
          </Button>
        }
      />
      <Card>
        <CardContent className="p-0">
          {!items ? (
            <TableSkeleton
              cols={5}
              widths={["50%", "70%", "60%", "35%", "20%"]}
            />
          ) : items.length === 0 ? (
            <EmptyState msg="No users yet — optional, for organizing keys" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="max-w-[14rem] truncate font-medium">
                      {u.name}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                      {u.email ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[28rem] truncate text-muted-foreground">
                      {u.notes ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.enabled ? "success" : "warning"}>
                        {u.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditing(u)}
                        title="Edit user"
                        aria-label="Edit user"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {(creating || editing) && (
        <UserDialog
          user={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function UserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: User | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [notes, setNotes] = useState(user?.notes ?? "");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      toast.error("name is required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        email: email.trim() || null,
        notes: notes.trim() || null,
        enabled,
      };
      if (user) await api.updateUser(user.id, payload);
      else await api.createUser(payload);
      toast.success(user ? "User updated" : "User created");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!user) return;
    if (!confirm(`Delete user '${user.name}'? Their keys will be unassigned.`))
      return;
    try {
      await api.deleteUser(user.id);
      toast.success("User deleted");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? "Edit User" : "New User"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Notes">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </Field>
          <label className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <span className="text-xs font-medium text-muted-foreground normal-case">
              Enabled
            </span>
          </label>
        </div>
        <DialogFooter className={user ? "justify-between" : ""}>
          {user && (
            <Button variant="destructive" onClick={del}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              <Check className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
