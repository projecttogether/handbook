import { createRoute, notFound, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import { focusRoute } from "@/routes/focus";
import { EditPage, type ChangeSetParam } from "./edit-page";
import { HistoryPage } from "./history-page";
import { PageView } from "./page-view";
import { RevisionPage } from "./revision-page";
import { SpacePage } from "@/modules/spaces/space-page";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const checkId = ({ params }: { params: { id: string } }) => {
  if (!UUID.test(params.id)) throw notFound();
};

/** `?changeSet=12` (a number) or `?changeSet=new`. */
export const changeSetSearch = z.object({
  changeSet: z
    .union([z.literal("new"), z.coerce.number().int().min(1)])
    .optional()
    .catch(undefined),
});

export function parseChangeSet(value: number | "new" | undefined): ChangeSetParam {
  return value;
}

const pageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/s/$space/$",
  component: function PageRoute() {
    const params = pageRoute.useParams();
    const path = (params._splat ?? "").replace(/\/+$/, "");
    // The router also matches /s/<space> and /s/<space>/ here, with an empty path.
    if (!path) return <SpacePage key={params.space} space={params.space} />;
    return <PageView key={`${params.space}/${path}`} space={params.space} path={path} />;
  },
});

const editRoute = createRoute({
  getParentRoute: () => focusRoute,
  path: "/pages/$id/edit",
  beforeLoad: checkId,
  validateSearch: changeSetSearch,
  component: function EditRoute() {
    const { id } = editRoute.useParams();
    const { changeSet } = editRoute.useSearch();
    return <EditPage key={`${id}-${String(changeSet)}`} pageId={id} changeSet={parseChangeSet(changeSet)} />;
  },
});

const historyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/pages/$id/history",
  beforeLoad: checkId,
  validateSearch: z.object({
    page: z.coerce.number().int().min(1).max(100_000).optional().catch(undefined),
  }),
  component: function HistoryRoute() {
    const { id } = historyRoute.useParams();
    const { page } = historyRoute.useSearch();
    const navigate = historyRoute.useNavigate();
    return (
      <HistoryPage
        pageId={id}
        page={page ?? 1}
        onPage={(next) => void navigate({ search: { page: next > 1 ? next : undefined } })}
      />
    );
  },
});

const revisionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/pages/$id/history/$number",
  beforeLoad: ({ params }) => {
    if (!UUID.test(params.id) || !/^[1-9]\d{0,9}$/.test(params.number)) throw notFound();
  },
  component: function RevisionRoute() {
    const { id, number } = revisionRoute.useParams();
    return <RevisionPage key={`${id}-${number}`} pageId={id} number={Number(number)} />;
  },
});

export const routes: AnyRoute[] = [pageRoute, historyRoute, revisionRoute];
export const focusRoutes: AnyRoute[] = [editRoute];
