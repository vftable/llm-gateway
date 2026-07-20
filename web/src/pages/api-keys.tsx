import { memo, useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Check, X, Copy, Pencil } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { ApiKey, User } from "@/lib/types";
import {
  PageHeader,
  TableSkeleton,
  EmptyState,
  Field,
  Pagination,
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
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtNum, relTime } from "@/lib/utils";

const PAGE_SIZE = 15;

export default function ApiKeys() {
  const [items, setItems] = useState<ApiKey[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<ApiKey | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(
    () => api.listApiKeys().then(setItems).catch(toast.error),
    [],
  );
  useEffect(() => {
    load();
    api
      .listUsers()
      .then(setUsers)
      .catch(() => {});
  }, [load]);

  const pageCount = Math.max(1, Math.ceil((items?.length ?? 0) / PAGE_SIZE));
  const visible = items?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];

  return (
    <div>
      <PageHeader
        title="API Keys"
        desc="Gateway credentials for client authentication, with per-key daily token quotas"
        meta={<Badge variant="secondary">{items?.length ?? 0} total</Badge>}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Key
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {!items ? (
            <TableSkeleton
              cols={7}
              widths={["55%", "40%", "50%", "30%", "45%", "25%", "20%"]}
            />
          ) : items.length === 0 ? (
            <EmptyState msg="No keys yet — until you create one, the gateway is open (no auth)" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Quota / Day</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((k) => (
                  <KeyRow
                    key={k.id}
                    apiKey={k}
                    onEdit={setEditing}
                    onChanged={load}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {items && (
            <Pagination page={page} pageCount={pageCount} onChange={setPage} />
          )}
        </CardContent>
      </Card>

      {creating && (
        <KeyCreateDialog
          users={users}
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setNewKey(k);
            load();
          }}
        />
      )}

      {newKey && (
        <KeyRevealDialog apiKey={newKey} onClose={() => setNewKey(null)} />
      )}

      {editing && (
        <KeyEditDialog
          apiKey={editing}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

const KeyRow = memo(function KeyRow({
  apiKey: k,
  onEdit,
  onChanged,
}: {
  apiKey: ApiKey;
  onEdit: (k: ApiKey) => void;
  onChanged: () => void;
}) {
  const [toggling, setToggling] = useState(false);

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await api.updateApiKey(k.id, { enabled });
      toast.success(enabled ? "Key enabled" : "Key disabled");
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  return (
    <TableRow>
      <TableCell className="max-w-[12rem] truncate">{k.name ?? "—"}</TableCell>
      <TableCell>
        <span className="font-mono text-primary">{k.keyPrefix}</span>
      </TableCell>
      <TableCell className="max-w-[12rem] truncate">
        {k.userName ?? "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {k.tokensPerDay ? fmtNum(k.tokensPerDay) : "∞"}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {relTime(k.lastUsedAt)}
      </TableCell>
      <TableCell>
        <Switch
          checked={k.enabled}
          disabled={toggling}
          onCheckedChange={toggle}
          title={k.enabled ? "Disable" : "Enable"}
        />
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onEdit(k)}
          title="Edit"
          className="text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
});

function KeyCreateDialog({
  users,
  onClose,
  onCreated,
}: {
  users: User[];
  onClose: () => void;
  onCreated: (k: ApiKey) => void;
}) {
  const [name, setName] = useState("");
  const [userId, setUserId] = useState<string>("none");
  const [quota, setQuota] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const k = await api.createApiKey({
        name: name.trim() || null,
        userId: userId === "none" ? null : userId,
        tokensPerDay: quota.trim() ? Number(quota) : null,
      });
      onCreated(k);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New API Key</DialogTitle>
          <DialogDescription>
            A fresh credential will be generated. Copy it now — the full value
            won't be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Label (optional)">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="production bot"
            />
          </Field>
          <Field label="Owner">
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Daily token quota"
            hint="blank = unlimited; resets at UTC midnight"
          >
            <Input
              type="number"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              placeholder="1000000"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            <Check className="h-3.5 w-3.5" />
            {saving ? "Generating…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyRevealDialog({
  apiKey,
  onClose,
}: {
  apiKey: ApiKey;
  onClose: () => void;
}) {
  const full = apiKey.keyFull ?? "";
  const copy = () => {
    navigator.clipboard.writeText(full);
    toast.success("Key copied");
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-amber-500 dark:text-amber-400!">
            Save This Key Now
          </DialogTitle>
          <DialogDescription>
            This is the only time the full key will be shown. Store it securely.
          </DialogDescription>
        </DialogHeader>
        <div className="bg-card rounded-lg border border-border flex items-center gap-2 p-2">
          <code className="flex-1 break-all px-2 py-1 text-xs text-primary">
            {full}
          </code>
          <Button variant="outline" size="icon" onClick={copy}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>
            <Check className="h-3.5 w-3.5" />
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyEditDialog({
  apiKey,
  users,
  onClose,
  onSaved,
}: {
  apiKey: ApiKey;
  users: User[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(apiKey.name ?? "");
  const [userId, setUserId] = useState(apiKey.userId ?? "none");
  const [quota, setQuota] = useState(apiKey.tokensPerDay?.toString() ?? "");
  const [enabled, setEnabled] = useState(apiKey.enabled);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateApiKey(apiKey.id, {
        name: name.trim() || null,
        userId: userId === "none" ? null : userId,
        tokensPerDay: quota.trim() ? Number(quota) : null,
        enabled,
      });
      toast.success("Key updated");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!confirm(`Revoke key '${apiKey.name ?? apiKey.keyPrefix}'?`)) return;
    try {
      await api.deleteApiKey(apiKey.id);
      toast.success("Key revoked");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit key · {apiKey.keyPrefix}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Label">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Owner">
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Daily token quota">
            <Input
              type="number"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <span className="text-xs font-medium text-muted-foreground normal-case">
              Enabled
            </span>
          </label>
        </div>
        <DialogFooter className="justify-between">
          <Button variant="destructive" onClick={del}>
            <Trash2 className="h-3.5 w-3.5" />
            Revoke
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
