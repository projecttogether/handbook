import type { PageSummary } from "@handbook/shared/api/pages";

export type TreeNode = { page: PageSummary; children: TreeNode[] };

/** Builds the page tree from the flat list (siblings by position, then title). */
export function buildTree(pages: PageSummary[]): TreeNode[] {
  const nodes = new Map(pages.map((page) => [page.id, { page, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.page.parentId ? nodes.get(node.page.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.page.position - b.page.position || a.page.title.localeCompare(b.page.title));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** Every page in tree order with its depth (for pickers). */
export function flattenTree(nodes: TreeNode[], depth = 0): { page: PageSummary; depth: number }[] {
  return nodes.flatMap((node) => [{ page: node.page, depth }, ...flattenTree(node.children, depth + 1)]);
}
