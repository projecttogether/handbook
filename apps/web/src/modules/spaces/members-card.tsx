import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { Space, SpaceMember } from "@handbook/shared/api/spaces";
import type { SpaceRole } from "@handbook/shared/roles";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { membersQuery } from "@/components/page/queries";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { messages } from "./messages";

/** Owners and editors of a space: add by email (also before their first sign-in), change, remove. */
export function MembersCard({ space }: { space: Space }) {
  const t = useT(messages);
  const queryClient = useQueryClient();
  const emailId = useId();
  const roleId = useId();
  const members = useQuery(membersQuery(space.slug));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SpaceRole>("editor");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<SpaceMember | null>(null);
  const canOwners = space.abilities.manageOwners;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["space", space.slug] });
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  };

  const put = useMutation({
    mutationFn: (input: { email: string; role: SpaceRole }) =>
      api.put<unknown>(`/spaces/${encodeURIComponent(space.slug)}/members`, input),
    onSuccess: async (_result, input) => {
      await refresh();
      toast.success(t("memberAdded", { email: input.email }));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fields) setFields(error.fields);
      toast.error(errorMessage(error));
    },
  });

  const add = (event: FormEvent) => {
    event.preventDefault();
    setFields({});
    put.mutate({ email: email.trim().toLowerCase(), role }, { onSuccess: () => setEmail("") });
  };

  const remove = async (member: SpaceMember) => {
    try {
      await api.delete(`/spaces/${encodeURIComponent(space.slug)}/members/${member.userId}`);
      await refresh();
      toast.success(t("memberRemoved", { email: member.email }));
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  const roleLabel = (value: SpaceRole) => (value === "owner" ? t("roleOwner") : t("roleEditor"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("members")}</CardTitle>
        <CardDescription>{t("membersHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {members.isPending ? (
          <LoadingState />
        ) : members.error ? (
          <ErrorState error={members.error} onRetry={() => void members.refetch()} />
        ) : members.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noMembers")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {members.data.items.map((member) => {
              const locked = member.role === "owner" && !canOwners;
              return (
                <li key={member.userId} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{member.name || member.email}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {member.email}
                      {member.signedIn ? null : (
                        <Badge variant="outline" className="ml-2">
                          {t("notSignedIn")}
                        </Badge>
                      )}
                    </p>
                  </div>
                  <Select
                    value={member.role}
                    disabled={locked || put.isPending}
                    onValueChange={(value) => put.mutate({ email: member.email, role: value as SpaceRole })}
                  >
                    <SelectTrigger className="w-32" aria-label={t("role")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {canOwners || member.role === "owner" ? (
                        <SelectItem value="owner">{roleLabel("owner")}</SelectItem>
                      ) : null}
                      <SelectItem value="editor">{roleLabel("editor")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={locked}
                    aria-label={t("removeMember", { email: member.email })}
                    onClick={() => setRemoving(member)}
                  >
                    <X />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
          <Field data-invalid={Boolean(fields.email)}>
            <FieldLabel htmlFor={emailId}>{t("email")}</FieldLabel>
            <Input
              id={emailId}
              type="email"
              required
              value={email}
              placeholder="name@example.org"
              onChange={(event) => setEmail(event.target.value)}
            />
            {fields.email ? <FieldError>{fields.email}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={roleId}>{t("role")}</FieldLabel>
            <Select value={role} onValueChange={(value) => setRole(value as SpaceRole)}>
              <SelectTrigger id={roleId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="editor">{roleLabel("editor")}</SelectItem>
                {canOwners ? <SelectItem value="owner">{roleLabel("owner")}</SelectItem> : null}
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" disabled={put.isPending || !email.trim()}>
            {put.isPending ? <Spinner /> : null}
            {t("addMember")}
          </Button>
        </form>
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("removeTitle", { email: removing?.email ?? "" })}
        description={t("removeText")}
        confirmLabel={t("removeMember", { email: removing?.email ?? "" })}
        destructive
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </Card>
  );
}
