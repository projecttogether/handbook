import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Library, Plus, Settings } from "lucide-react";
import type { SpaceSummary } from "@handbook/shared/api/spaces";
import { MAX_SPACE_SLUG_LENGTH, slugify } from "@handbook/shared/paths";
import {
  SPACE_TEMPLATE_KEYS,
  SPACE_TEMPLATES,
  type SpaceTemplateKey,
} from "@handbook/shared/space-templates";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { ApiError, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useAllSpaces, useArchiveSpace, useCreateSpace } from "./api";
import { messages } from "./messages";

/** A URL slug from a space name, within the space slug's length. */
export function spaceSlugFrom(name: string): string {
  return slugify(name, "").slice(0, MAX_SPACE_SLUG_LENGTH).replace(/-+$/, "");
}

function CreateSpaceDialog(props: { onClose: () => void }) {
  const t = useT(messages);
  const tc = useT(common);
  const navigate = useNavigate();
  const create = useCreateSpace();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<SpaceTemplateKey>("blank");
  const fields = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};
  const generalError =
    create.error && !(create.error instanceof ApiError && create.error.fields) ? create.error : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), slug: slug.trim(), description: description.trim(), template },
      {
        onSuccess: (space) => {
          toast.success(t("created"));
          props.onClose();
          void navigate({ to: "/s/$space/-/settings", params: { space: space.slug } });
        },
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && props.onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("createSpaceTitle")}</DialogTitle>
            <DialogDescription>{t("createSpaceDescription")}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(fields.name)}>
            <FieldLabel htmlFor="space-name">{t("spaceName")}</FieldLabel>
            <Input
              id="space-name"
              value={name}
              maxLength={80}
              required
              aria-invalid={Boolean(fields.name)}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugEdited) setSlug(spaceSlugFrom(event.target.value));
              }}
            />
            {fields.name ? <FieldError>{fields.name}</FieldError> : null}
          </Field>
          <Field data-invalid={Boolean(fields.slug)}>
            <FieldLabel htmlFor="space-slug">{t("spaceSlug")}</FieldLabel>
            <Input
              id="space-slug"
              value={slug}
              maxLength={MAX_SPACE_SLUG_LENGTH}
              required
              className="font-mono"
              aria-invalid={Boolean(fields.slug)}
              onChange={(event) => {
                setSlug(event.target.value.toLowerCase());
                setSlugEdited(true);
              }}
            />
            <FieldDescription>{t("spaceSlugHint", { slug: slug || "…" })}</FieldDescription>
            {fields.slug ? <FieldError>{fields.slug}</FieldError> : null}
          </Field>
          <Field data-invalid={Boolean(fields.description)}>
            <FieldLabel htmlFor="space-description">{t("spaceDescription")}</FieldLabel>
            <Textarea
              id="space-description"
              value={description}
              maxLength={500}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
            <FieldDescription>{t("spaceDescriptionHint")}</FieldDescription>
            {fields.description ? <FieldError>{fields.description}</FieldError> : null}
          </Field>
          <TemplatePicker value={template} onChange={setTemplate} error={fields.template} />
          {generalError ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(generalError)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={props.onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !slug.trim()}>
              {create.isPending ? <Spinner /> : null}
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The template a new space starts with, and what it brings. */
function TemplatePicker(props: {
  value: SpaceTemplateKey;
  onChange: (value: SpaceTemplateKey) => void;
  error: string | undefined;
}) {
  const t = useT(messages);
  const chosen = SPACE_TEMPLATES[props.value];
  return (
    <FieldSet>
      <FieldLegend variant="label">{t("template")}</FieldLegend>
      <FieldDescription>{t("templateHint")}</FieldDescription>
      <RadioGroup
        value={props.value}
        onValueChange={(value) => props.onChange(value as SpaceTemplateKey)}
        className="grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {SPACE_TEMPLATE_KEYS.map((key) => (
          <FieldLabel key={key} htmlFor={`template-${key}`} className="[&>*]:data-[slot=field]:p-3">
            <Field orientation="horizontal">
              <RadioGroupItem value={key} id={`template-${key}`} />
              <FieldContent>
                <FieldTitle>{SPACE_TEMPLATES[key].label}</FieldTitle>
                <FieldDescription className="text-xs">{SPACE_TEMPLATES[key].description}</FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
      <FieldDescription>
        {t("templateTypes", { types: chosen.pageTypes.map((pageType) => pageType.label).join(", ") })}{" "}
        {chosen.pages.length > 0
          ? t("templatePages", { pages: chosen.pages.map((page) => page.title).join(", ") })
          : t("templateNoPages")}
      </FieldDescription>
      {props.error ? <FieldError>{props.error}</FieldError> : null}
    </FieldSet>
  );
}

function SpaceRow(props: { space: SpaceSummary; onArchive: (space: SpaceSummary) => void }) {
  const t = useT(messages);
  const format = useFormatter();
  const archive = useArchiveSpace();
  const { space } = props;
  const archived = space.archived;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/s/$space" params={{ space: space.slug }} className="font-medium hover:underline">
            {space.name}
          </Link>
          <span className="text-muted-foreground font-mono text-xs">/s/{space.slug}</span>
          {archived ? <Badge variant="secondary">{t("archived")}</Badge> : null}
        </div>
        {space.description ? (
          <p className="text-muted-foreground text-sm break-words">{space.description}</p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {t("pages", { count: space.pageCount })} · {t("colUpdated")} {format.relative(space.updatedAt)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/s/$space/-/settings" params={{ space: space.slug }}>
            <Settings />
            {t("settings")}
          </Link>
        </Button>
        {archived ? (
          <Button
            variant="outline"
            size="sm"
            disabled={archive.isPending}
            onClick={() =>
              archive.mutate(
                { slug: space.slug, archive: false },
                {
                  onSuccess: () => toast.success(t("unarchivedDone")),
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            {archive.isPending ? <Spinner /> : <ArchiveRestore />}
            {t("unarchive")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => props.onArchive(space)}>
            <Archive />
            {t("archive")}
          </Button>
        )}
      </div>
    </li>
  );
}

export function AdminSpacesPage() {
  const t = useT(messages);
  const spaces = useAllSpaces();
  const archive = useArchiveSpace();
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<SpaceSummary | null>(null);
  return (
    <Page>
      <PageHeader
        title={t("spacesTitle")}
        description={t("spacesDescription")}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus />
            {t("newSpace")}
          </Button>
        }
      />
      {spaces.isLoading ? (
        <LoadingState />
      ) : spaces.isError || !spaces.data ? (
        <ErrorState error={spaces.error} onRetry={() => void spaces.refetch()} />
      ) : spaces.data.items.length === 0 ? (
        <EmptyState
          icon={<Library />}
          title={t("noSpaces")}
          description={t("noSpacesHint")}
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus />
              {t("newSpace")}
            </Button>
          }
        />
      ) : (
        <Card className="py-0">
          <ul className="divide-y">
            {spaces.data.items.map((space) => (
              <SpaceRow key={space.id} space={space} onArchive={setArchiving} />
            ))}
          </ul>
        </Card>
      )}
      {creating ? <CreateSpaceDialog onClose={() => setCreating(false)} /> : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={t("archiveTitle", { name: archiving?.name ?? "" })}
        description={t("archiveDescription")}
        confirmLabel={t("archive")}
        destructive
        onConfirm={() =>
          archiving &&
          archive.mutateAsync({ slug: archiving.slug, archive: true }).then(
            () => toast.success(t("archivedDone")),
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
