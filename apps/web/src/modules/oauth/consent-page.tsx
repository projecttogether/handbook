import { useState, type ReactNode } from "react";
import { Check, CircleSlash, ShieldAlert, X } from "lucide-react";
import { AppIcon } from "@/components/brand";
import { LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n";
import { useAuthConfig } from "@/lib/auth-config";
import { useOauthDecision, useOauthRequest } from "./api";
import { messages } from "./messages";

const DEFAULT_APP_NAME = "Handbook";

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="bg-muted/40 flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

/**
 * The consent screen of a connected app (OAuth): the person approves or
 * denies, and the browser returns to the app with a code or an error.
 * The app's name is its own claim: the screen shows what was checked (the
 * host of a metadata document) and where the browser goes next.
 */
export function ConsentPage(props: { requestId: string; onRedirect?: (url: string) => void }) {
  const t = useT(messages);
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  const request = useOauthRequest(props.requestId);
  const decide = useOauthDecision(props.requestId);
  const [leaving, setLeaving] = useState(false);
  const redirect = props.onRedirect ?? ((url: string) => window.location.assign(url));

  const choose = (decision: "approve" | "deny") =>
    decide.mutate(decision, {
      onSuccess: (result) => {
        setLeaving(true);
        redirect(result.redirectUrl);
      },
    });

  if (request.isLoading) {
    return (
      <Frame>
        <LoadingState />
      </Frame>
    );
  }
  if (request.isError || !request.data) {
    return (
      <Frame>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <CircleSlash className="size-5" aria-hidden />
              <h1>{t("expiredTitle")}</h1>
            </CardTitle>
            <CardDescription>{t("expiredText")}</CardDescription>
          </CardHeader>
        </Card>
      </Frame>
    );
  }

  const data = request.data;
  const busy = decide.isPending || leaving;
  return (
    <Frame>
      <Card>
        <CardHeader>
          <AppIcon className="mb-2 size-10" />
          <CardTitle className="text-xl">
            <h1>{t("title", { app: data.clientName })}</h1>
          </CardTitle>
          <CardDescription>{t("description", { app: data.clientName, appName })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="divide-y rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
              <dt className="text-muted-foreground">{t("identifiedBy")}</dt>
              <dd>
                {data.clientHost ? (
                  <span className="font-mono font-medium break-all">{data.clientHost}</span>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-amber-600/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                  >
                    <ShieldAlert aria-hidden />
                    {t("notVerified")}
                  </Badge>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
              <dt className="text-muted-foreground">{t("returnsTo")}</dt>
              <dd className="font-mono font-medium break-all">{data.redirectHost}</dd>
            </div>
          </dl>
          <p className="text-muted-foreground">
            {data.clientHost ? t("registeredDocument", { host: data.clientHost }) : t("registeredDynamic")}
          </p>
          <div className="space-y-2">
            <p className="font-medium">{t("mayTitle")}</p>
            <ul className="space-y-1.5">
              <li className="flex gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                {t("mayRead")}
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                {t("mayPropose")}
              </li>
              <li className="flex gap-2">
                <X className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                {t("mayNot")}
              </li>
            </ul>
          </div>
          <p className="text-muted-foreground">{t("disconnect")}</p>
          {decide.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{t("failed")}</AlertDescription>
            </Alert>
          ) : null}
          {leaving ? (
            <p role="status" className="text-muted-foreground">
              {t("leaving")}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={busy} onClick={() => choose("deny")}>
            {t("deny")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => choose("approve")}>
            {decide.isPending && decide.variables === "approve" ? <Spinner /> : null}
            {t("approve")}
          </Button>
        </CardFooter>
      </Card>
    </Frame>
  );
}
