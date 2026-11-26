import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, KeyRound, Plug, Plus } from "lucide-react";
import type { ConnectedApp, Token } from "@handbook/shared/api/tokens";
import type { About } from "@handbook/shared/api/users";
import { OrganizationLogo } from "@/components/brand";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AboutCard, AppearanceCard, KeyboardShortcutsCard } from "@/components/ui/settings-cards";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useMaybeMe } from "@/hooks/use-me";
import { commitUrl, REPOSITORY_URL } from "@/lib/repository";
import { useTheme } from "@/lib/theme";
import {
  useConnectedApps,
  useConnectInfo,
  useCreateToken,
  useDisconnectApp,
  useRevokeToken,
  useTokens,
} from "./api";
import { messages } from "./messages";
import { CreateTokenDialog, TokenSecretDialog } from "./token-dialogs";

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="bg-muted block overflow-x-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre">
      {children}
    </code>
  );
}

function ConnectCard() {
  const t = useT(messages);
  const info = useConnectInfo();
  const url = info.data?.mcpUrl ?? "";
  const clients: { title: string; body: ReactNode }[] = [
    { title: t("clientClaude"), body: <p>{t("clientClaudeText")}</p> },
    { title: t("clientChatgpt"), body: <p>{t("clientChatgptText")}</p> },
    { title: t("clientLangdock"), body: <p>{t("clientLangdockText")}</p> },
    {
      title: t("clientClaudeCode"),
      body: (
        <div className="space-y-2">
          <p>{t("clientClaudeCodeText")}</p>
          <Code>{`claude mcp add --transport http handbook ${url}`}</Code>
          <p>{t("clientClaudeCodeToken")}</p>
          <Code>{`claude mcp add --transport http handbook ${url} \\\n  --header "Authorization: Bearer <token>"`}</Code>
        </div>
      ),
    },
    { title: t("clientOther"), body: <p>{t("clientOtherText")}</p> },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4" aria-hidden />
          {t("connectTitle")}
        </CardTitle>
        <CardDescription>{t("connectDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {info.isLoading ? (
          <LoadingState />
        ) : info.isError ? (
          <ErrorState error={info.error} onRetry={() => void info.refetch()} />
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm font-medium" id="mcp-url-label">
              {t("mcpUrl")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code
                aria-labelledby="mcp-url-label"
                className="bg-muted min-w-0 flex-1 rounded-md px-3 py-2 font-mono text-sm break-all"
              >
                {url}
              </code>
              <CopyButton text={url} />
            </div>
          </div>
        )}
        <dl className="grid gap-4 text-sm md:grid-cols-2">
          {clients.map((client) => (
            <div key={client.title} className="space-y-1">
              <dt className="font-medium">{client.title}</dt>
              <dd className="text-muted-foreground">{client.body}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function TokensCard() {
  const t = useT(messages);
  const format = useFormatter();
  const tokens = useTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden />
          {t("tokensTitle")}
        </CardTitle>
        <CardDescription>{t("tokensDescription")}</CardDescription>
        <CardAction>
          <Button
            size="sm"
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            <Plus />
            {t("newToken")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {tokens.isLoading ? (
          <LoadingState />
        ) : tokens.isError || !tokens.data ? (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : tokens.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noTokens")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colToken")}</TableHead>
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
                      {t("colCreated")} {format.dateTime(token.createdAt)}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{token.prefix}</TableCell>
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
        )}
      </CardContent>
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
    </Card>
  );
}

function AppsCard() {
  const t = useT(messages);
  const format = useFormatter();
  const apps = useConnectedApps();
  const disconnect = useDisconnectApp();
  const [removing, setRemoving] = useState<ConnectedApp | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" aria-hidden />
          {t("appsTitle")}
        </CardTitle>
        <CardDescription>{t("appsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {apps.isLoading ? (
          <LoadingState />
        ) : apps.isError || !apps.data ? (
          <ErrorState error={apps.error} onRetry={() => void apps.refetch()} />
        ) : apps.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noApps")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colApp")}</TableHead>
                <TableHead>{t("colRedirect")}</TableHead>
                <TableHead>{t("colConnected")}</TableHead>
                <TableHead>{t("colLastUsed")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("disconnect")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.data.items.map((app) => (
                <TableRow key={app.id}>
                  <TableCell className="font-medium whitespace-normal">{app.clientName}</TableCell>
                  <TableCell className="font-mono text-xs">{app.redirectHost}</TableCell>
                  <TableCell>{format.dateTime(app.createdAt)}</TableCell>
                  <TableCell>{app.lastUsedAt ? format.relative(app.lastUsedAt) : t("notUsed")}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(app)}>
                      {t("disconnect")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("disconnectTitle", { name: removing?.clientName ?? "" })}
        description={t("disconnectDescription")}
        confirmLabel={t("disconnect")}
        destructive
        onConfirm={() =>
          removing &&
          disconnect.mutateAsync(removing.id).then(
            () => toast.success(t("disconnected")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </Card>
  );
}

export function SettingsPage() {
  const t = useT(messages);
  const { theme, setTheme } = useTheme();
  const admin = useMaybeMe()?.isAdmin === true;
  // The version that runs: admins only, as before on the Updates page.
  const about = useQuery({
    queryKey: ["about"],
    queryFn: () => api.get<About>("/about"),
    enabled: admin,
  }).data;
  const version = admin ? about?.version : undefined;
  return (
    <Page className="max-w-5xl">
      <PageHeader title={t("title")} description={t("description")} />
      <Alert>
        <Bot />
        <AlertTitle>{t("agentsTitle")}</AlertTitle>
        <AlertDescription>{t("agentsText")}</AlertDescription>
      </Alert>
      <ConnectCard />
      <AppsCard />
      <TokensCard />
      <AppearanceCard value={theme} onChange={setTheme} />
      <KeyboardShortcutsCard />
      {/* The software's name, also when an installation renames the app. */}
      <AboutCard
        logo={<OrganizationLogo className="size-10 rounded-md" />}
        text={t("about")}
        version={version}
        versionHref={version ? commitUrl(version) : undefined}
        repositoryUrl={REPOSITORY_URL}
      />
    </Page>
  );
}
