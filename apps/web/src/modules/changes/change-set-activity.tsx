import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  CircleDot,
  CircleSlash,
  GitMerge,
  MessageSquare,
  MessageSquareWarning,
  Pencil,
  RotateCcw,
  Send,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { ChangeSet, ChangeSetEvent } from "@handbook/shared/api/changes";
import { MarkdownView } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { changeSetApi, useChangeSetAction } from "./api";
import { useAuthorLabel } from "./author";
import { messages } from "./messages";

const ICONS: Record<ChangeSetEvent["kind"], LucideIcon> = {
  created: CircleDot,
  edited: Pencil,
  comment: MessageSquare,
  submitted: Send,
  changes_requested: MessageSquareWarning,
  merged: GitMerge,
  closed: CircleSlash,
  reopened: RotateCcw,
  reverted: Undo2,
};

function EventItem(props: { changeSet: ChangeSet; event: ChangeSetEvent }) {
  const t = useT(messages);
  const format = useFormatter();
  const authorLabel = useAuthorLabel();
  const { event } = props;
  const Icon = ICONS[event.kind];
  const what =
    event.kind === "edited"
      ? event.page
        ? t("event_edited", { page: event.page.title })
        : t("event_editedNoPage")
      : t(`event_${event.kind}`);
  const showBody =
    event.body &&
    (event.kind === "comment" || event.kind === "changes_requested" || event.kind === "submitted");
  return (
    <li className="flex gap-3">
      <span className="bg-muted text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm">
          <span className="font-medium">{authorLabel(event.actor, event.clientName)}</span> {what}{" "}
          <time
            dateTime={event.createdAt}
            title={format.dateTime(event.createdAt)}
            className="text-muted-foreground"
          >
            {format.relative(event.createdAt)}
          </time>
        </p>
        {event.kind === "edited" && event.body ? (
          <p className="text-muted-foreground text-sm break-words">{event.body}</p>
        ) : null}
        {showBody ? (
          <div className="bg-card rounded-md border px-3 py-2">
            <MarkdownView markdown={event.body ?? ""} space={props.changeSet.space.slug} path="" />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function CommentForm({ changeSet }: { changeSet: ChangeSet }) {
  const t = useT(messages);
  const [body, setBody] = useState("");
  const comment = useChangeSetAction((text: string) => changeSetApi.comment(changeSet.number, text));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    comment.mutate(text, {
      onSuccess: () => {
        setBody("");
        toast.success(t("commented"));
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };
  return (
    <form onSubmit={submit} className="grid gap-2">
      <Label htmlFor="change-set-comment">{t("commentLabel")}</Label>
      <Textarea
        id="change-set-comment"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={t("commentPlaceholder")}
        rows={3}
        maxLength={10_000}
      />
      <div>
        <Button type="submit" disabled={comment.isPending || body.trim() === ""}>
          {comment.isPending ? <Spinner /> : <MessageSquare />}
          {t("commentSend")}
        </Button>
      </div>
    </form>
  );
}

/** The timeline of a change set and, for people who may, a comment box. */
export function ChangeSetActivity({ changeSet }: { changeSet: ChangeSet }) {
  return (
    <div className="space-y-5">
      <ol className="space-y-4">
        {changeSet.events.map((event) => (
          <EventItem key={event.id} changeSet={changeSet} event={event} />
        ))}
      </ol>
      {changeSet.permissions.comment ? <CommentForm changeSet={changeSet} /> : null}
    </div>
  );
}
