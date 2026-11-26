import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Page } from "@handbook/shared/api/pages";
import { isWithin, lastSegment, parentPath } from "@handbook/shared/paths";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { treeQuery } from "@/components/page/queries";
import { buildTree, flattenTree } from "@/components/page/tree";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { messages } from "./messages";

const TOP = "__top";

/** Moves or renames a page (with the pages below it). */
export function MoveDialog(props: {
  page: Page;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMoved: (page: { id: string; path: string }) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const queryClient = useQueryClient();
  const parentId = useId();
  const slugId = useId();
  const [parent, setParent] = useState(parentPath(props.page.path) ?? TOP);
  const [slug, setSlug] = useState(lastSegment(props.page.path));
  const [fields, setFields] = useState<Record<string, string>>({});
  const tree = useQuery({ ...treeQuery(props.page.space), enabled: props.open });
  const choices = flattenTree(buildTree(tree.data?.items ?? [])).filter(
    (item) => !isWithin(item.page.path, props.page.path),
  );

  const move = useMutation({
    mutationFn: () =>
      api.post<Partial<Page>>(`/pages/${props.page.id}/move`, {
        parentPath: parent === TOP ? null : parent,
        slug: slug.trim(),
      }),
    onSuccess: async (result) => {
      const path = result?.path ?? (parent === TOP ? slug.trim() : `${parent}/${slug.trim()}`);
      await queryClient.invalidateQueries({ queryKey: ["space", props.page.space] });
      await queryClient.invalidateQueries({ queryKey: ["page", props.page.id] });
      toast.success(t("moved"));
      props.onOpenChange(false);
      props.onMoved({ id: props.page.id, path });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fields) setFields(error.fields);
      toast.error(errorMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFields({});
    move.mutate();
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !move.isPending && props.onOpenChange(open)}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("moveTitle", { title: props.page.title })}</DialogTitle>
            <DialogDescription>{t("moveText")}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(fields.parentPath || fields.path)}>
            <FieldLabel htmlFor={parentId}>{t("parent")}</FieldLabel>
            <Select value={parent} onValueChange={setParent}>
              <SelectTrigger id={parentId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TOP}>{t("topLevel")}</SelectItem>
                {choices.map((item) => (
                  <SelectItem key={item.page.id} value={item.page.path}>
                    <span style={{ paddingLeft: `${item.depth * 0.75}rem` }}>{item.page.title}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fields.parentPath || fields.path ? (
              <FieldError>{fields.parentPath ?? fields.path}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={Boolean(fields.slug)}>
            <FieldLabel htmlFor={slugId}>{t("slug")}</FieldLabel>
            <Input id={slugId} value={slug} required onChange={(event) => setSlug(event.target.value)} />
            <FieldDescription>{t("slugHelp")}</FieldDescription>
            {fields.slug ? <FieldError>{fields.slug}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={move.isPending}
              onClick={() => props.onOpenChange(false)}
            >
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={move.isPending || !slug.trim()}>
              {move.isPending ? <Spinner /> : null}
              {t("move")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
