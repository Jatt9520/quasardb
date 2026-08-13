import { BtreeSnapshot } from "./btree.js";

export interface RenderOptions {
  /** show only the leaf chain (sibling links), not the internal levels */
  leavesOnly?: boolean;
}

function depthOf(snap: BtreeSnapshot[], node: BtreeSnapshot): number {
  let d = 0;
  let cur: BtreeSnapshot | undefined = node;
  const seen = new Set<number>();
  while (cur && cur.parent !== 0) {
    if (seen.has(cur.pageId)) break; // guard against cyclic parent chains
    seen.add(cur.pageId);
    const parent = snap.find((s) => s.pageId === cur!.parent);
    if (!parent) break;
    d++;
    cur = parent;
  }
  return d;
}

function describe(node: BtreeSnapshot): string {
  const kind = node.kind === "leaf" ? "leaf" : "internal";
  if (node.kind === "leaf") {
    const keys = node.keys.length === 0 ? "(empty)" : node.keys.join(", ");
    const tail = node.nextLeaf !== 0 ? ` -> p${node.nextLeaf}` : " -> end";
    return `[p${node.pageId}] ${kind} ${node.keys.length} key(s): ${keys}${tail}`;
  }
  const ptrs = node.keys.map((k, i) => `${k}→p${node.values[i]}`).join(", ");
  const left = node.leftmostChild !== 0 ? ` left→p${node.leftmostChild}` : "";
  return `[p${node.pageId}] ${kind} ${node.keys.length} key(s): ${ptrs}${left}`;
}

/** ASCII rendering of the whole tree, one line per node, indented by depth. */
export function renderTree(snap: BtreeSnapshot[], _opts: RenderOptions = {}): string {
  if (snap.length === 0) return "(empty tree)";
  const root = snap.find((s) => s.parent === 0) ?? snap[0];
  const maxDepth = Math.max(...snap.map((s) => depthOf(snap, s)));
  // group children by parent
  const children = new Map<number, BtreeSnapshot[]>();
  for (const s of snap) {
    if (s.parent === 0) continue;
    const arr = children.get(s.parent) ?? [];
    arr.push(s);
    children.set(s.parent, arr);
  }
  const lines: string[] = [];
  const queue: Array<{ node: BtreeSnapshot; indent: number }> = [{ node: root, indent: 0 }];
  const visited = new Set<number>();
  while (queue.length > 0 && visited.size <= snap.length) {
    const { node, indent } = queue.shift()!;
    if (visited.has(node.pageId)) break; // guard against child cycles
    visited.add(node.pageId);
    lines.push("  ".repeat(indent) + (indent > 0 ? "└─ " : "") + describe(node));
    const kids = children.get(node.pageId) ?? [];
    for (const kid of kids) queue.push({ node: kid, indent: indent + 1 });
  }
  lines.push(`depth ${maxDepth}, ${snap.length} page(s)`);
  return lines.join("\n");
}

/** Render only the leaf chain: the last level linked via nextLeaf. */
export function renderLeafChain(snap: BtreeSnapshot[], _opts: RenderOptions = {}): string {
  if (snap.length === 0) return "(empty tree)";
  let head = snap.find((s) => s.kind === "leaf" && s.parent === 0);
  if (!head) {
    // find the leftmost leaf: descend leftmostChild from the root
    const root = snap.find((s) => s.parent === 0) ?? snap[0];
    let cur = root;
    while (cur.kind === "internal" && cur.leftmostChild !== 0) {
      const kid = snap.find((s) => s.pageId === cur.leftmostChild);
      if (!kid) break;
      cur = kid;
    }
    head = cur.kind === "leaf" ? cur : snap.find((s) => s.kind === "leaf");
  }
  if (!head) return "(no leaves)";
  const lines: string[] = [];
  let cur: BtreeSnapshot | undefined = head;
  let guard = 0;
  while (cur && guard++ < 10000) {
    lines.push(
      `[p${cur.pageId}] ${cur.keys.length} key(s): ${cur.keys.length === 0 ? "(empty)" : cur.keys.join(", ")}${cur.nextLeaf !== 0 ? ` -> p${cur.nextLeaf}` : " -> end"}`,
    );
    cur = snap.find((s) => s.pageId === cur!.nextLeaf);
  }
  lines.push(`${lines.length} leaf page(s)`);
  return lines.join("\n");
}

/** Aggregate statistics about fill and shape. */
export function renderStats(snap: BtreeSnapshot[], order: number): string {
  if (snap.length === 0) return "(empty tree)";
  const leaves = snap.filter((s) => s.kind === "leaf");
  const internals = snap.filter((s) => s.kind === "internal");
  const maxDepth = 1 + Math.max(...snap.map((s) => depthOf(snap, s)));
  const totalKeys = snap.reduce((acc, s) => acc + s.keys.length, 0);
  const leafKeys = leaves.reduce((acc, s) => acc + s.keys.length, 0);
  const maxFill = Math.max(0, ...leaves.map((s) => s.keys.length));
  const avgFill = leaves.length === 0 ? 0 : leafKeys / leaves.length;
  const internalFill = internals.map((s) => s.keys.length);
  const lines = [
    `pages: ${snap.length} (${internals.length} internal, ${leaves.length} leaf)`,
    `depth: ${maxDepth}`,
    `keys: ${totalKeys} total, ${leafKeys} in leaves`,
    `order: ${order} (max keys per node)`,
    `leaf fill: avg ${avgFill.toFixed(2)}, max ${maxFill}, utilization ${(avgFill / Math.max(1, order) * 100).toFixed(1)}%`,
  ];
  if (internalFill.length > 0) {
    lines.push(`internal fill: avg ${(internalFill.reduce((a, b) => a + b, 0) / internalFill.length).toFixed(2)}, max ${Math.max(...internalFill)}`);
  }
  return lines.join("\n");
}