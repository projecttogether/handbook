import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Plus } from "lucide-react";
import type { ServiceToken } from "@handbook/shared/api/tokens";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { CreateTokenDialog, TokenSecretDialog } from "@/modules/settings/token-dialogs";
import { useCreateServiceToken, useRevokeServiceToken, useServiceTokens } from "./api";
import { messages } from "./messages";

export function AdminServiceTokensPage() {
  const t = useT(messages);
  const format = useFormatter();
  const tokens = useServiceTokens();
  const create = useCreateServiceToken();
  const revoke = useRevokeServiceToken();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ServiceToken | null>(null);
  const openCreate = () => {
    create.reset();
    setCreating(true);
  };
  return (
    <Page>
      <PageHeader
        title={t("tokensTitle")}
        description={t("tokensDescription")}
        actions={
          <Button onClick={openCreate}>
            <Plus />
            {t("newToken")}
          </Button>
        }
      />
      {tokens.isLoading ? (
        <LoadingState />
      ) : tokens.isError || !tokens.data ? (
        <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : tokens.data.items.length === 0 ? (
        <EmptyState icon={<KeyRound />} title={t("noTokens")} description={t("noTokensHint")} />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colToken")}</TableHead>
                <TableHead>{t("colCreatedBy")}</TableHead>
                <TableHead>{t("colLastUsed")}</TableHead>
                <TableHead>{t("colExpires")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("revoke")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.data.items.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium whitespace-normal">
                    {token.name}
                    <div className="text-muted-foreground text-xs font-normal">
                      {format.dateTime(token.createdAt)}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{token.prefix}</TableCell>
                  <TableCell className="whitespace-normal">{token.createdBy ?? "–"}</TableCell>
                  <TableCell>{token.lastUsedAt ? format.relative(token.lastUsedAt) : t("notUsed")}</TableCell>
                  <TableCell>{token.expiresAt ? format.dateTime(token.expiresAt) : t("never")}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setRevoking(token)}>
                      {t("revoke")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {creating ? (
        <CreateTokenDialog
          open
          onOpenChange={setCreating}
          title={t("createTokenTitle")}
          description={t("createTokenDescription")}
          nameHint={t("tokenNameHint")}
          pending={create.isPending}
          error={create.error}
          onCreate={(input) =>
            create.mutate(input, {
              onSuccess: (created) => {
                setCreating(false);
                setSecret(created.secret);
                toast.success(t("tokenCreated"));
              },
            })
          }
        />
      ) : null}
      <TokenSecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("revokeTitle", { name: revoking?.name ?? "" })}
        description={t("revokeDescription")}
        confirmLabel={t("revoke")}
        destructive
        onConfirm={() =>
          revoking &&
          revoke.mutateAsync(revoking.id).then(
            () => toast.success(t("revoked")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </Page>
  );
}
