import { BtreeEntry } from "../btree/btree.js";
import { BtreeIndex } from "../btree/btree.js";
import { compareKeys, decodeCompositeKeyParts, decodeTypedKey, encodeCompositeKey, encodeTypedKey } from "../btree/btree.js";
import { Expr } from "../sql/ast.js";
import { TableHeap } from "../storage/tableHeap.js";
import { Value, compareValues, truthy, valueHashKey } from "../expr/value.js";
import { containsSubquery, evalExpr, evalExprAsync, SubqueryRunner } from "../expr/evaluator.js";
import { TableMeta } from "../storage/catalog.js";
import { deserializeRow, Schema, schemaOf } from "../storage/record.js";
import { AggregateNode, DistinctNode, FilterNode, IndexScanNode, JoinNode, LimitNode, PlanNode, ProjectNode, SetOpNode, SortNode, TableScanNode } from "../planner/plan.js";

// ========================= Row model =========================

export interface Row {
  /** raw values aligned with `schema` */
  values: Value[];
  /** name of each column */
  schema: string[];
  /** table alias for qualification */
  tables: string[];
}

export function makeRow(values: Value[], schema: string[], tables: string[]): Row {
  return { values, schema, tables };
}

/** Standard eval context: resolve by column name (first match wins). */
export function rowContext(row: Row, tableHint?: string | null, fallback?: import("../expr/evaluator.js").EvalContext | null): {
  getColumn(name: string, hint: string | null): Value;
} {
  return {
    getColumn(name, hint) {
      if (name === "*") return null;
      const wanted = hint ?? tableHint ?? null;
      for (let i = 0; i < row.schema.length; i++) {
        if (row.schema[i] === name) {
          if (wanted !== null && row.tables[i] !== wanted) continue;
          return row.values[i];
        }
      }
      if (fallback) return fallback.getColumn(name, hint);
      throw new Error(`no column "${name}"`);
    },
  };
}

// ========================= Base iterator =========================

export interface Operator {
  next(): Promise<Row | null>;
  close(): Promise<void>;
  stats: { rows: number; timeMs: number; pages: number };
}

export abstract class BaseOperator implements Operator {
  stats = { rows: 0, timeMs: 0, pages: 0 };
  protected started = false;

  async next(): Promise<Row | null> {
    if (!this.started) {
      this.started = true;
      this.stats.timeMs = performance.now();
    }
    const row = await this.nextInner();
    if (row) this.stats.rows++;
    else this.stats.timeMs = performance.now() - this.stats.timeMs;
    return row;
  }

  protected abstract nextInner(): Promise<Row | null>;

  async close(): Promise<void> {}
}

// ========================= Operators =========================

export interface ExecContext {
  heaps: Map<string, TableHeap>;
  meta: Map<string, TableMeta>;
  indexes: Map<string, BtreeIndex[]>;
  subquery?: SubqueryRunner;
  /** outer row context for correlated subqueries */
  outer?: import("../expr/evaluator.js").EvalContext | null;
  emitProgress?: (label: string, rowCount: number) => void;
}

export class ScanOperator extends BaseOperator {
  constructor(
    private node: TableScanNode,
    private ctx: ExecContext,
  ) {
    super();
  }

  private singleRowEmitted = false;
  private iter: AsyncIterator<{ pageId: number; index: number; record: Uint8Array; delete: () => Promise<void> }> | null = null;
  private schema: Schema | null = null;
  private schemaNames: string[] = [];
  private tables: string[] = [];

  async nextInner(): Promise<Row | null> {
    if (this.node.table === "__single_row__") {
      if (this.singleRowEmitted) return null;
      this.singleRowEmitted = true;
      return makeRow([], [], []);
    }
    if (!this.iter) {
      const tableKey = this.node.table.toLowerCase();
      const heap = this.ctx.heaps.get(tableKey);
      if (!heap) throw new Error(`Table "${this.node.table}" not found`);
      const meta = this.ctx.meta.get(tableKey);
      if (!meta) throw new Error(`Table "${this.node.table}" not found`);
      this.schema = schemaOf(meta.name, meta.columns);
      this.schemaNames = meta.columns.map((c) => c.name);
      this.tables = meta.columns.map(() => this.node.alias.toLowerCase());
      this.iter = (await heap.scan())[Symbol.asyncIterator]();
    }
    const res = await this.iter.next();
    if (res.done) return null;
    const row = deserializeRow(this.schema!, res.value.record);
    this.stats.pages++;
    return makeRow(row, this.schemaNames, this.tables);
  }
}

export class IndexScanOperator extends BaseOperator {
  constructor(
    private node: IndexScanNode,
    private ctx: ExecContext,
  ) {
    super();
  }

  private iter: AsyncIterator<BtreeEntry & { pageId: number }> | null = null;
  private locator: Map<number, { pageId: number; index: number }> | null = null;
  private schema: Schema | null = null;
  private schemaNames: string[] = [];
  private tables: string[] = [];
  private tableKey = "";
  private prefixLen = 0;
  private prefixValues: Value[] = [];
  private singleCol = false;

  private colType(col: string): string {
    const c = this.schema?.columns.find((x) => x.name.toLowerCase() === col.toLowerCase());
    return c?.type ?? "text";
  }

  async nextInner(): Promise<Row | null> {
    if (!this.iter) {
      this.tableKey = this.node.table.toLowerCase();
      const meta = this.ctx.meta.get(this.tableKey);
      if (!meta) throw new Error(`Table "${this.node.table}" not found`);
      this.schema = schemaOf(meta.name, meta.columns);
      this.schemaNames = meta.columns.map((c) => c.name);
      this.tables = meta.columns.map(() => this.node.alias.toLowerCase());
      const idx = this.ctx.indexes.get(this.tableKey)?.find((i) => i.name.toLowerCase() === this.node.index.toLowerCase());
      if (!idx) throw new Error(`Index "${this.node.index}" not found`);
      this.prefixLen = this.node.prefix.length;
      this.prefixValues = this.node.prefix.map((k) => k.value);
      this.singleCol = idx.columns.length === 1;
      this.iter = idx.scanRange(this.buildBound(this.node.lo), null)[Symbol.asyncIterator]();
      this.locator = new Map();
      for await (const { pageId, index, rid } of this.heap.scan()) {
        this.locator.set(rid, { pageId, index });
      }
    }
    const p = this.node.prefix;
    for (;;) {
      const res = await this.iter.next();
      if (res.done) return null;
      const parts = this.singleCol
        ? [decodeTypedKey(res.value.key)]
        : decodeCompositeKeyParts(res.value.key);
      // rows are ordered by (prefix values, rest): stop once the prefix diverges
      let inPrefix = parts.length >= this.prefixLen;
      if (inPrefix) {
        for (let i = 0; i < this.prefixLen; i++) {
          if (compareValues(parts[i], this.prefixValues[i]) !== 0) {
            inPrefix = false;
            break;
          }
        }
      }
      if (!inPrefix) return null;
      if (this.node.hi && parts.length > this.prefixLen && compareValues(parts[this.prefixLen], this.node.hi.value) > 0) {
        return null;
      }
      const loc = this.locator!.get(res.value.value);
      if (!loc) continue;
      const record = await this.heap.getSlot(loc.pageId, loc.index);
      if (record === null) continue;
      const row = deserializeRow(this.schema!, record);
      this.stats.pages++;
      return makeRow(row, this.schemaNames, this.tables);
    }
  }

  /** Start key for the scan: composite(prefix values..., bound) or a bare typed key. */
  private buildBound(bound: { col: string; value: Value } | null): Uint8Array | null {
    const parts: Uint8Array[] = [];
    for (const k of this.node.prefix) parts.push(encodeTypedKey(k.value, this.colType(k.col)));
    if (bound) parts.push(encodeTypedKey(bound.value, this.colType(bound.col)));
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : encodeCompositeKey(parts);
  }

  private get heap(): TableHeap {
    const h = this.ctx.heaps.get(this.tableKey);
    if (!h) throw new Error(`Table "${this.node.table}" not found`);
    return h;
  }
}

export class FilterOperator extends BaseOperator {
  constructor(
    private child: Operator,
    private expr: Expr,
    private ctx: ExecContext,
  ) {
    super();
  }

  async nextInner(): Promise<Row | null> {
    for (;;) {
      const row = await this.child.next();
      if (!row) return null;
      const v = await evalFilterExpr(this.expr, row, this.ctx);
      if (truthy(v)) return row;
    }
  }
}

/** Eval an expression on a row, using the async subquery path when needed. */
function evalFilterExpr(expr: Expr, row: Row, ctx: ExecContext): Promise<Value> | Value {
  const rc = rowContext(row, undefined, ctx.outer ?? null);
  if (containsSubquery(expr)) {
    if (!ctx.subquery) throw new Error("Subquery execution is not available in this context");
    return evalExprAsync(expr, rc, ctx.subquery);
  }
  return evalExpr(expr, rc);
}

export class ProjectOperator extends BaseOperator {
  constructor(
    private child: Operator,
    private node: ProjectNode,
    private ctx: ExecContext,
  ) {
    super();
  }

  async nextInner(): Promise<Row | null> {
    const row = await this.child.next();
    if (!row) return null;
    const values: Value[] = [];
    const names: string[] = [];
    const tables: string[] = [];
    for (const item of this.node.exprs) {
      if (item.expr.kind === "col" && item.expr.name === "*") {
        // star: expand all columns
        for (let i = 0; i < row.values.length; i++) {
          values.push(row.values[i]);
          names.push(row.schema[i]);
          tables.push(row.tables[i]);
        }
        continue;
      }
      const v = await evalFilterExpr(item.expr, row, this.ctx);
      values.push(v);
      names.push(item.out ?? "");
      tables.push(item.table ?? "");
    }
    return makeRow(values, names, tables);
  }
}

export class NestedLoopJoinOperator extends BaseOperator {
  constructor(
    private left: Operator,
    private right: Operator,
    private on: Expr | null,
    private joinType: JoinNode["joinType"],
    private ctx: ExecContext,
  ) {
    super();
  }

  private leftRow: Row | null = null;
  private rightRows: Row[] | null = null;
  private rightIdx = 0;
  private leftMatched = false;
  /** right join: set of right row indices already matched */
  private matchedRight: Set<number> | null = null;
  /** right join: phase 2 emits unmatched right rows */
  private rightPhase = false;
  private emitIdx = 0;
  private leftSchema: string[] = [];
  private leftTables: string[] = [];

  async nextInner(): Promise<Row | null> {
    if (this.rightRows === null) {
      this.rightRows = [];
      for (;;) {
        const r = await this.right.next();
        if (!r) break;
        this.rightRows.push(r);
      }
      if (this.joinType === "right") {
        this.matchedRight = new Set();
        this.leftSchema = [];
        this.leftTables = [];
      }
    }
    if (this.joinType === "right") return this.nextRightJoin();
    for (;;) {
      if (!this.leftRow) {
        this.leftRow = await this.left.next();
        if (!this.leftRow) {
          return null;
        }
        this.rightIdx = 0;
        this.leftMatched = false;
      }
      const right = this.rightRows[this.rightIdx];
      if (right === undefined) {
        if (this.joinType === "left" && !this.leftMatched) {
          const values: Value[] = [...this.leftRow.values];
          const names = [...this.leftRow.schema];
          const tabs = [...this.leftRow.tables];
          const nullCount = this.rightRows.length > 0 ? this.rightRows[0].values.length : 0;
          for (let i = 0; i < nullCount; i++) {
            values.push(null);
            names.push(this.rightRows[0]!.schema[i]);
            tabs.push(this.rightRows[0]!.tables[i]);
          }
          this.leftRow = null;
          return makeRow(values, names, tabs);
        }
        this.leftRow = null;
        continue;
      }
      this.rightIdx++;
      const values = [...this.leftRow.values, ...right.values];
      const names = [...this.leftRow.schema, ...right.schema];
      const tabs = [...this.leftRow.tables, ...right.tables];
      if (this.on) {
        const v = await evalFilterExpr(this.on, makeRow(values, names, tabs), this.ctx);
        if (truthy(v)) {
          this.leftMatched = true;
          return makeRow(values, names, tabs);
        }
      } else {
        return makeRow(values, names, tabs);
      }
    }
  }

  private async nextRightJoin(): Promise<Row | null> {
    for (;;) {
      if (this.rightPhase) {
        if (this.emitIdx >= this.rightRows!.length) return null;
        const r = this.rightRows![this.emitIdx++];
        if (this.matchedRight!.has(this.emitIdx - 1)) continue;
        const values: Value[] = [...this.leftSchema.map(() => null), ...r.values];
        const names = [...this.leftSchema, ...r.schema];
        const tabs = [...this.leftTables, ...r.tables];
        return makeRow(values, names, tabs);
      }
      if (!this.leftRow) {
        this.leftRow = await this.left.next();
        if (!this.leftRow) {
          this.rightPhase = true;
          this.emitIdx = 0;
          continue;
        }
        if (this.leftSchema.length === 0) {
          this.leftSchema = this.leftRow.schema;
          this.leftTables = this.leftRow.tables;
        }
        this.rightIdx = 0;
        this.leftMatched = false;
      }
      const right = this.rightRows![this.rightIdx];
      if (right === undefined) {
        if (!this.leftMatched) {
          // unmatched left rows are dropped in a right join
        }
        this.leftRow = null;
        continue;
      }
      this.rightIdx++;
      const values = [...this.leftRow.values, ...right.values];
      const names = [...this.leftRow.schema, ...right.schema];
      const tabs = [...this.leftRow.tables, ...right.tables];
      if (this.on) {
        const v = await evalFilterExpr(this.on, makeRow(values, names, tabs), this.ctx);
        if (truthy(v)) {
          this.leftMatched = true;
          this.matchedRight!.add(this.rightIdx - 1);
          return makeRow(values, names, tabs);
        }
      } else {
        this.matchedRight!.add(this.rightIdx - 1);
        return makeRow(values, names, tabs);
      }
    }
  }
}

export class HashJoinOperator extends BaseOperator {
  private buildComplete = false;
  private probeRow: Row | null = null;
  private matched: Row[] | null = null;
  private matchedIdx = 0;

  constructor(
    private left: Operator, // build
    private right: Operator, // probe
    private leftKeys: Expr[],
    private rightKeys: Expr[],
    private extraOn: Expr | null,
    private joinType: JoinNode["joinType"],
  ) {
    super();
  }

  private table = new Map<string, Row[]>();

  async nextInner(): Promise<Row | null> {
    if (!this.buildComplete) {
      for (;;) {
        const row = await this.left.next();
        if (!row) break;
        const key = this.joinKey(row, this.leftKeys);
        const arr = this.table.get(key);
        if (arr) arr.push(row);
        else this.table.set(key, [row]);
      }
      this.buildComplete = true;
    }
    for (;;) {
      if (this.matched && this.matchedIdx < this.matched.length) {
        const m = this.matched[this.matchedIdx++];
        return this.combine(this.probeRow!, m);
      }
      this.probeRow = await this.right.next();
      if (!this.probeRow) {
        if (this.joinType === "left") {
          // emit unmatched left rows (left is build)
          return null; // skipped for brevity; NLJ handles left joins
        }
        return null;
      }
      const key = this.joinKey(this.probeRow, this.rightKeys);
      const bucket = this.table.get(key);
      if (bucket) {
        this.matched = bucket.filter((l) => {
          if (!this.extraOn) return true;
          const values = [...l.values, ...this.probeRow!.values];
          const names = [...l.schema, ...this.probeRow!.schema];
          const tabs = [...l.tables, ...this.probeRow!.tables];
          return truthy(evalExpr(this.extraOn!, rowContext(makeRow(values, names, tabs))));
        });
      } else {
        this.matched = [];
      }
      this.matchedIdx = 0;
    }
  }

  private joinKey(row: Row, keys: Expr[]): string {
    return keys.map((k) => valueHashKey(evalExpr(k, rowContext(row)))).join("#");
  }

  private combine(l: Row, r: Row): Row {
    return makeRow([...l.values, ...r.values], [...l.schema, ...r.schema], [...l.tables, ...r.tables]);
  }
}

export class HashAggregateOperator extends BaseOperator {
  constructor(
    private child: Operator,
    private node: AggregateNode,
  ) {
    super();
  }

  private groups = new Map<string, { key: Row; rows: Row[] }>();
  private built = false;
  private iter: Iterator<{ key: Row; rows: Row[] }> | null = null;

  async nextInner(): Promise<Row | null> {
    if (!this.built) {
      for (;;) {
        const row = await this.child.next();
        if (!row) break;
        const keyStr = this.node.groupBy.map((g) => valueHashKey(evalExpr(g, rowContext(row)))).join("#");
        const keyRow = makeRow(
          this.node.groupBy.map((g) => evalExpr(g, rowContext(row))),
          this.node.groupBy.map((_, i) => `group_key_${i}`),
          [],
        );
        const existing = this.groups.get(keyStr);
        if (existing) existing.rows.push(row);
        else this.groups.set(keyStr, { key: keyRow, rows: [row] });
      }
      // no GROUP BY: a single global group, even over zero input rows
      if (this.node.groupBy.length === 0 && this.groups.size === 0) {
        this.groups.set("", { key: makeRow([], [], []), rows: [] });
      }
      this.built = true;
      this.iter = this.groups.values();
    }
    const next = this.iter!.next();
    if (next.done) return null;
    const { key, rows } = next.value;
    const values: Value[] = [...key.values];
    const names: string[] = [];
    const tables: string[] = [];
    for (let i = 0; i < key.values.length; i++) {
      names.push(`__grp_${i}`);
      tables.push("");
    }
    for (let i = 0; i < this.node.aggs.length; i++) {
      const agg = this.node.aggs[i];
      const v = this.evalAgg(agg.expr, rows);
      values.push(v);
      names.push(`__agg_${i}`);
      tables.push("");
    }
    return makeRow(values, names, tables);
  }

  private evalAgg(expr: Expr, rows: Row[]): Value {
    if (expr.kind === "col") {
      return rows.length > 0 ? evalExpr(expr, rowContext(rows[0])) : null;
    }
    if (expr.kind !== "func") {
      // e.g. SELECT a+b FROM t GROUP BY a+b — evaluate on first row (assume in group by)
      return rows.length > 0 ? evalExpr(expr, rowContext(rows[0])) : null;
    }
    const name = expr.name.toLowerCase();
    const argExpr = expr.args[0];
    if (expr.star && name === "count") {
      return rows.length;
    }
    switch (name) {
      case "count": {
        if (expr.distinct) {
          const set = new Set<string>();
          for (const r of rows) {
            const v = evalExpr(argExpr, rowContext(r));
            if (v !== null) set.add(valueHashKey(v));
          }
          return set.size;
        }
        let n = 0;
        for (const r of rows) {
          const v = evalExpr(argExpr, rowContext(r));
          if (v !== null) n++;
        }
        return n;
      }
      case "sum": {
        let sum = 0;
        let any = false;
        for (const r of rows) {
          const v = evalExpr(argExpr, rowContext(r));
          if (v !== null && typeof v === "number") {
            sum += v;
            any = true;
          }
        }
        return any ? sum : null;
      }
      case "avg": {
        let sum = 0;
        let n = 0;
        for (const r of rows) {
          const v = evalExpr(argExpr, rowContext(r));
          if (v !== null && typeof v === "number") {
            sum += v;
            n++;
          }
        }
        return n === 0 ? null : sum / n;
      }
      case "min": {
        let best: Value = null;
        for (const r of rows) {
          const v = evalExpr(argExpr, rowContext(r));
          if (v !== null && (best === null || compareValues(v, best) < 0)) best = v;
        }
        return best;
      }
      case "max": {
        let best: Value = null;
        for (const r of rows) {
          const v = evalExpr(argExpr, rowContext(r));
          if (v !== null && (best === null || compareValues(v, best) > 0)) best = v;
        }
        return best;
      }
      case "group_concat": {
        const parts: string[] = [];
        for (const r of rows) {
          const v = evalExpr(argExpr, rowContext(r));
          if (v !== null) parts.push(String(v));
        }
        return parts.join(",");
      }
      default:
        throw new Error(`Unknown aggregate function "${expr.name}"`);
    }
  }
}

export class SortOperator extends BaseOperator {
  constructor(
    private child: Operator,
    private node: SortNode,
  ) {
    super();
  }

  private rows: Row[] | null = null;
  private idx = 0;

  async nextInner(): Promise<Row | null> {
    if (!this.rows) {
      this.rows = [];
      for (;;) {
        const r = await this.child.next();
        if (!r) break;
        this.rows.push(r);
      }
      const by = this.node.by;
      this.rows.sort((a, b) => {
        for (const item of by) {
          const va = evalExpr(item.expr, rowContext(a));
          const vb = evalExpr(item.expr, rowContext(b));
          let c = compareValues(va, vb);
          if (item.desc) c = -c;
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    if (this.idx >= this.rows.length) return null;
    return this.rows[this.idx++];
  }
}

export class LimitOperator extends BaseOperator {
  constructor(
    private child: Operator,
    private limit: number | null,
    private offset: number,
  ) {
    super();
  }

  private emitted = 0;
  private skipped = 0;

  async nextInner(): Promise<Row | null> {
    for (;;) {
      if (this.limit !== null && this.emitted >= this.limit) return null;
      if (this.limit === null && this.skipped >= this.offset) return null;
      const row = await this.child.next();
      if (!row) return null;
      if (this.skipped < this.offset) {
        this.skipped++;
        continue;
      }
      this.emitted++;
      return row;
    }
  }
}

export class DistinctOperator extends BaseOperator {
  constructor(private child: Operator) {
    super();
  }

  private seen = new Set<string>();

  async nextInner(): Promise<Row | null> {
    for (;;) {
      const row = await this.child.next();
      if (!row) return null;
      const key = row.values.map(valueHashKey).join("#");
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      return row;
    }
  }
}

export class SetOpOperator extends BaseOperator {
  constructor(
    private left: Operator,
    private right: Operator,
    private op: "union" | "intersect" | "except",
    private all: boolean,
  ) {
    super();
  }

  private unionLeftDone = false;
  private seen = new Set<string>();
  private rightCounts: Map<string, number> | null = null;
  private emitted = new Set<string>();

  private key(row: Row): string {
    return row.values.map(valueHashKey).join("#");
  }

  private async loadRight(): Promise<void> {
    this.rightCounts = new Map();
    for (;;) {
      const row = await this.right.next();
      if (!row) break;
      const k = this.key(row);
      this.rightCounts.set(k, (this.rightCounts.get(k) ?? 0) + 1);
    }
    await this.right.close();
  }

  async nextInner(): Promise<Row | null> {
    if (this.op === "union") {
      for (;;) {
        if (!this.unionLeftDone) {
          const row = await this.left.next();
          if (row) {
            const k = this.key(row);
            if (!this.all && this.seen.has(k)) continue;
            this.seen.add(k);
            return row;
          }
          this.unionLeftDone = true;
          await this.left.close();
          continue;
        }
        const row = await this.right.next();
        if (!row) return null;
        const k = this.key(row);
        if (!this.all && this.seen.has(k)) continue;
        this.seen.add(k);
        return row;
      }
    }
    if (this.rightCounts === null) await this.loadRight();
    for (;;) {
      const row = await this.left.next();
      if (!row) return null;
      const k = this.key(row);
      const cnt = this.rightCounts!.get(k) ?? 0;
      if (this.op === "intersect") {
        if (this.all) {
          if (cnt === 0) continue;
          this.rightCounts!.set(k, cnt - 1);
          return row;
        }
        if (cnt > 0 && !this.emitted.has(k)) {
          this.emitted.add(k);
          return row;
        }
      } else {
        if (this.all) {
          if (cnt > 0) {
            this.rightCounts!.set(k, cnt - 1);
            continue;
          }
          return row;
        }
        if (cnt === 0 && !this.emitted.has(k)) {
          this.emitted.add(k);
          return row;
        }
      }
    }
  }

  override async close(): Promise<void> {
    await this.left.close();
    if (this.rightCounts === null) await this.right.close();
  }
}

// ========================= Builder =========================

export function buildOperator(plan: PlanNode, ctx: ExecContext): Operator {
  switch (plan.kind) {
    case "scan":
      return new ScanOperator(plan as TableScanNode, ctx);
    case "indexscan":
      return new IndexScanOperator(plan as IndexScanNode, ctx);
    case "filter": {
      const p = plan as FilterNode;
      return new FilterOperator(buildOperator(p.children[0], ctx), p.expr, ctx);
    }
    case "project": {
      const p = plan as ProjectNode;
      return new ProjectOperator(buildOperator(p.children[0], ctx), p, ctx);
    }
    case "join": {
      const p = plan as JoinNode;
      const left = buildOperator(p.children[0], ctx);
      const right = buildOperator(p.children[1], ctx);
      const eq = p.equi === undefined ? extractEquiJoinKeys(p.on) : p.equi;
      if (eq && p.joinType === "inner") {
        return new HashJoinOperator(left, right, eq.leftKeys, eq.rightKeys, eq.extraOn, p.joinType);
      }
      return new NestedLoopJoinOperator(left, right, p.on, p.joinType, ctx);
    }
    case "aggregate": {
      const p = plan as AggregateNode;
      return new HashAggregateOperator(buildOperator(p.children[0], ctx), p);
    }
    case "sort": {
      const p = plan as SortNode;
      return new SortOperator(buildOperator(p.children[0], ctx), p);
    }
    case "limit": {
      const p = plan as LimitNode;
      return new LimitOperator(buildOperator(p.children[0], ctx), p.limit, p.offset);
    }
    case "distinct": {
      const p = plan as DistinctNode;
      return new DistinctOperator(buildOperator(p.children[0], ctx));
    }
    case "setop": {
      const p = plan as SetOpNode;
      return new SetOpOperator(buildOperator(p.children[0], ctx), buildOperator(p.children[1], ctx), p.op, p.all);
    }
    default:
      throw new Error(`Unsupported plan node "${(plan as PlanNode).kind}"`);
  }
}

/** Extract equi-join keys from an ON expr: colA = colB. */
function extractEquiJoinKeys(on: Expr | null): { leftKeys: Expr[]; rightKeys: Expr[]; extraOn: Expr | null } | null {
  if (!on) return null;
  if (on.kind === "binop" && on.op === "=") {
    const l = on.left;
    const r = on.right;
    if (l.kind === "col" && r.kind === "col") {
      return { leftKeys: [l], rightKeys: [r], extraOn: null };
    }
  }
  if (on.kind === "binop" && on.op === "and") {
    const part1 = extractEquiJoinKeys(on.left);
    const part2 = extractEquiJoinKeys(on.right);
    if (part1 && part2) {
      return {
        leftKeys: [...part1.leftKeys, ...part2.leftKeys],
        rightKeys: [...part1.rightKeys, ...part2.rightKeys],
        extraOn: null,
      };
    }
    if (part1) return { ...part1, extraOn: on.right };
    if (part2) return { ...part2, extraOn: on.left };
  }
  return null;
}