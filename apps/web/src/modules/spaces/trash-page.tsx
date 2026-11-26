import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Page as PageLayout, PageHeader } from "@/components/ui/page";
import { spaceQuery, trashQuery } from "@/components/page/queries";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useT } from "@/i18n";
import { messages } from "./messages";

/** Deleted pages of a space; editors restore them. */
export function TrashPage({ space: slug }: { space: string }) {
  const t = useT(messages);
  const format = useFormatter();
  const queryClient = useQueryClient();
  const space = useQuery(spaceQuery(slug));
  const trash = useQuery(trashQuery(slug));

  const restore = async (id: string) => {
    try {
      await api.post(`/pages/${id}/restore`);
      await queryClient.invalidateQueries({ queryKey: ["space", slug] });
      await queryClient.invalidateQueries({ queryKey: ["page", id] });
      toast.success(t("restored"));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  if (space.error || trash.error) {
    return (
      <PageLayout>
        <ErrorState error={space.error ?? trash.error} onRetry={() => void trash.refetch()} />
      </PageLayout>
    );
  }
  if (!space.data || !trash.data) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  const canRestore = space.data.abilities.editLive;
  return (
    <PageLayout>
      <div className="space-y-2">
        <Button variant="link" className="h-auto px-0 text-sm" asChild>
          <Link to="/s/$space" params={{ space: slug }}>
            <ArrowLeft />
            {space.data.name}
          </Link>
        </Button>
        <PageHeader title={t("trashTitle", { space: space.data.name })} description={t("trashHint")} />
      </div>
      {trash.data.items.length === 0 ? (
        <EmptyState icon={<Trash2 />} title={t("trashEmpty")} />
      ) : (
        <ul className="divide-y rounded-md border">
          {trash.data.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{item.title}</p>
                <p className="text-muted-foreground truncate text-sm">
                  {item.path} ·{" "}
                  {item.deletedBy
                    ? t("deletedBy", { time: format.relative(item.deletedAt), name: item.deletedBy.name })
                    : t("deletedAt", { time: format.relative(item.deletedAt) })}
                </p>
              </div>
              {canRestore ? (
                <Button variant="outline" size="sm" onClick={() => void restore(item.id)}>
                  <RotateCcw />
                  {t("restore")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PageLayout>
  );
}
