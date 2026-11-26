import { useState, type FormEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { defineMessages, useT } from "@/i18n";
import { common } from "@/i18n/common";
import { ApiError, errorMessage } from "@/lib/api";

const messages = defineMessages({
  en: {
    name: "Name",
    expiry: "Expires",
    days30: "In 30 days",
    days90: "In 90 days",
    days365: "In 1 year",
    never: "Never",
    create: "Create token",
    secretTitle: "Copy your token now",
    secretWarning: "You won't see it again. Store it in your agent's secret settings, never in shared files.",
    secretLabel: "Token",
    done: "Done",
  },
});

export const EXPIRY_OPTIONS = ["30", "90", "365", "never"] as const;
type Expiry = (typeof EXPIRY_OPTIONS)[number];

/** A form for a new token: name and expiry. `onCreate` gets days or null (never). */
export function CreateTokenDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  nameHint: string;
  pending: boolean;
  error: unknown;
  onCreate: (input: { name: string; expiresInDays: number | null }) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("90");
  const fields = props.error instanceof ApiError ? (props.error.fields ?? {}) : {};
  const generalError =
    props.error && !(props.error instanceof ApiError && props.error.fields) ? props.error : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onCreate({ name: name.trim(), expiresInDays: expiry === "never" ? null : Number(expiry) });
  };
  const labels: Record<Expiry, string> = {
    "30": t("days30"),
    "90": t("days90"),
    "365": t("days365"),
    never: t("never"),
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (props.pending) return;
        if (!open) {
          setName("");
          setExpiry("90");
        }
        props.onOpenChange(open);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(fields.name)}>
            <FieldLabel htmlFor="token-name">{t("name")}</FieldLabel>
            <Input
              id="token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              aria-invalid={Boolean(fields.name)}
            />
            <FieldDescription>{props.nameHint}</FieldDescription>
            {fields.name ? <FieldError>{fields.name}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="token-expiry">{t("expiry")}</FieldLabel>
            <Select value={expiry} onValueChange={(value) => setExpiry(value as Expiry)}>
              <SelectTrigger id="token-expiry" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {labels[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {generalError ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(generalError)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={props.pending}
              onClick={() => props.onOpenChange(false)}
            >
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={props.pending || name.trim() === ""}>
              {props.pending ? <Spinner /> : null}
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Shows a new token's secret once, hidden until shown. Closing the dialog forgets it. */
export function TokenSecretDialog(props: { secret: string | null; onClose: () => void }) {
  const t = useT(messages);
  return (
    <Dialog open={props.secret !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("secretTitle")}</DialogTitle>
        </DialogHeader>
        <Alert>
          <TriangleAlert />
          <AlertDescription>{t("secretWarning")}</AlertDescription>
        </Alert>
        <Field>
          <FieldLabel htmlFor="token-secret">{t("secretLabel")}</FieldLabel>
          <SecretInput
            id="token-secret"
            readOnly
            copyable
            value={props.secret ?? ""}
            inputClassName="font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
        </Field>
        <DialogFooter>
          <Button type="button" onClick={props.onClose}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
