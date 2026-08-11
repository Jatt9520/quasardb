import { CatalogData, TableMeta, IndexMeta } from "../storage/catalog.js";
import { BtreeIndex, encodeCompositeKey, encodeKeyBoolean, encodeKeyNull, encodeKeyNumber, encodeKeyString } from "../btree/btree.js";
import { TableHeap } from "../storage/tableHeap.js";
import {
  DeleteStmt, InsertStmt, SelectStmt, SetOpStmt, SqlType, Statement,
  UpdateStmt, CreateTableStmt, CreateIndexStmt, DropTableStmt, DropIndexStmt,
} from "../sql/ast.js";
import { Planner, IndexInfo } from "../planner/planner.js";
import { buildOperator, ExecContext, rowContext } from "../executor/executor.js";
import { evalExpr } from "../expr/evaluator.js";
import { Value, formatValue } from "../expr/value.js";
import { coerceRow, deserializeRow, serializeRow } from "../storage/record.js";
import type { Engine, QueryResult } from "./engine.js";

/**
 * A session: an isolated transaction context over a shared engine.
 * Sessions interleave at await points; the buffer pool's page version
 * chains give each session its own consistent read snapshot.
 */
export class Session {
  private e: Engine;
  private txnCatalog: CatalogData | null = null;
  private writeXid: number | null = null;
  private readSnap: number | null = null;

  constructor(engine: Engine) {
    this.e = engine;
  }

  get inTransaction(): boolean {
    return this.txnCatalog !== null;
  }

  /** Execute a prepared statement; returns query result. */
  async execute(statement: Statement, opts: { explain?: boolean; analyze?: boolean } = {}): Promise<QueryResult> {
    switch (statement.kind) {
      case "create_table":
      case "create_index":
      case "drop_table":
      case "drop_index":
      case "insert":
      case "update":
      case "delete":
        return this.executeWrite(statement, opts);
      case "select":
      case "setop":
        return this.executeRead(statement, opts);
      case "begin":
        return this.doBegin();
      case "commit":
        return this.doCommit();
      case "rollback":
        return this.doRollback();
    }
  }

  /** Write statements: single-statement atomicity when not in an explicit txn. */
  private async executeWrite(statement: Statement, opts: { explain?: boolean; analyze?: boolean }): Promise<QueryResult> {
    const inTxn = this.txnCatalog !== null;
    if (inTxn) {
      return this.runWrite(statement, opts, this.writeXid!);
    }
    const xid = this.e.pool.nextXid();
    const savedReadSnap = this.readSnap;
    this.readSnap = xid;
    this.e.pool.beginWrite(xid);
    const catalogBackup = JSON.parse(JSON.stringify(this.e.catalog.dataValue)) as CatalogData;
    try {
      const r = await this.runWrite(statement, opts, xid);
      this.e.pool.commitXid(xid);
      this.readSnap = savedReadSnap;
      return r;
    } catch (err) {
      try {
        await this.e.pool.rollbackXid(xid);
      } catch {
        // rollback failure leaves the pool in a conservative state; nothing more to do
      }
      this.e.catalog.restore(catalogBackup);
      this.readSnap = savedReadSnap;
      throw err;
    }
  }

  /** Read statements: run against a snapshot taken at statement start. */
  private async executeRead(statement: Statement, opts: { explain?: boolean; analyze?: boolean }): Promise<QueryResult> {
    if (this.txnCatalog) {
      return this.runRead(statement, opts, this.readSnap!);
    }
    const snap = this.e.pool.takeSnapshot();
    try {
      return await this.runRead(statement, opts, snap);
    } finally {
      this.e.pool.releaseSnapshot(snap);
    }
  }

  private async runWrite(statement: Statement, opts: { explain?: boolean; analyze?: boolean }, snap: number): Promise<QueryResult> {
    switch (statement.kind) {
      case "create_table":
        return this.doCreateTable(statement);
      case "create_index":
        return this.doCreateIndex(statement);
      case "drop_table":
        return this.doDropTable(statement);
      case "drop_index":
        return this.doDropIndex(statement);
      case "insert":
        return this.doInsert(statement, snap);
      case "update":
        return this.doUpdate(statement, snap);
      case "delete":
        return this.doDelete(statement, snap);
      default:
        return this.runRead(statement, opts, snap);
    }
  }

  private runRead(statement: Statement, opts: { explain?: boolean; analyze?: boolean }, snap: number): Promise<QueryResult> {
    return this.doSelect(statement as SelectStmt | SetOpStmt, opts, snap);
  }

  private doBegin(): QueryResult {
    if (this.txnCatalog) throw new Error("already in a transaction");
    this.txnCatalog = JSON.parse(JSON.stringify(this.e.catalog.dataValue)) as CatalogData;
    this.writeXid = this.e.pool.nextXid();
    this.e.pool.beginWrite(this.writeXid);
    this.e.pool.takeSnapshot(this.writeXid);
    this.readSnap = this.writeXid;
    return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
  }

  private async doCommit(): Promise<QueryResult> {
    if (!this.txnCatalog) throw new Error("no transaction in progress");
    this.e.pool.commitXid(this.writeXid!);
    this.e.pool.releaseSnapshot(this.writeXid!);
    this.txnCatalog = null;
    this.writeXid = null;
    this.readSnap = null;
    await this.e.syncAll();
    return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
  }

  private async doRollback(): Promise<QueryResult> {
    if (!this.txnCatalog) throw new Error("no transaction in progress");
    const snapshot = this.txnCatalog;
    this.txnCatalog = null;
    try {
      await this.e.pool.rollbackXid(this.writeXid!);
    } finally {
      this.e.pool.releaseSnapshot(this.writeXid!);
      this.writeXid = null;
      this.readSnap = null;
    }
    this.e.catalog.restore(snapshot);
    await this.e.commitCatalog();
    await this.e.syncAll();
    this.e.refreshState();
    return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
  }

  // ---------------- DDL ----------------

  private async doCreateTable(s: CreateTableStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const name = s.table.toLowerCase();
    if (this.e.catalog.getTable(name)) {
      if (s.ifNotExists) return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
      throw new Error(`Table "${s.table}" already exists`);
    }
    const cols = s.columns.map((c) => ({ ...c, type: c.type as SqlType }));
    let pk = s.primaryKey;
    for (const c of cols) {
      if (c.primaryKey) pk = c.name;
      if (pk && c.name === pk) {
        c.notNull = true;
        c.unique = true;
      }
    }
    // create heap
    const heap = await TableHeap.create(name, this.e.pool);
    const meta: TableMeta = {
      name,
      headerPageId: heap.headerPage,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        primaryKey: c.primaryKey ?? (pk === c.name),
        unique: c.unique ?? false,
        notNull: c.notNull ?? false,
        autoIncrement: c.autoIncrement ?? (pk === c.name && c.type === "int"),
      })),
      primaryKey: pk,
    };
    this.e.catalog.addTable(meta);
    await this.e.commitCatalog();
    this.e.heaps.set(name, heap);
    this.e.metas.set(name, meta);
    // auto-create unique index on primary key
    if (pk) {
      await this.buildIndex(`${name}__pk`, name, [pk], true, this.readSnap ?? undefined);
    }
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  private async doCreateIndex(s: CreateIndexStmt): Promise<QueryResult> {
    const t0 = performance.now();
    if (this.e.catalog.getIndex(s.index.toLowerCase())) {
      if (s.ifNotExists) return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
      throw new Error(`Index "${s.index}" already exists`);
    }
    await this.buildIndex(s.index, s.table, s.cols, false, this.readSnap ?? undefined);
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  private async buildIndex(name: string, table: string, cols: string[], unique: boolean, snap?: number): Promise<void> {
    const tKey = table.toLowerCase();
    const meta = this.e.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${table}" not found`);
    const idx = await BtreeIndex.create(name.toLowerCase(), table, cols, this.e.pool, unique);
    const heap = this.e.heaps.get(tKey)!;
    const schema = { name: meta.name, columns: meta.columns };
    let good = true;
    for await (const { record, rid } of heap.scan(snap)) {
      const row = deserializeRow(schema, record);
      const key = encodeCompositeIndexKey(cols, row, meta);
      try {
        await idx.insert(key, rid);
      } catch (e) {
        good = false;
        throw e;
      }
    }
    if (!good) throw new Error("Index build failed");
    const imeta: IndexMeta = {
      name: name.toLowerCase(),
      table,
      columns: cols,
      metaPageId: idx.metaPageIdValue,
      unique,
    };
    this.e.catalog.addIndex(imeta);
    const arr = this.e.indexes.get(tKey) ?? [];
    arr.push(idx);
    this.e.indexes.set(tKey, arr);
    await this.e.commitCatalog();
  }

  private async doDropTable(s: DropTableStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const meta = this.e.catalog.getTable(s.table);
    if (!meta) {
      if (s.ifExists) return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
      throw new Error(`Table "${s.table}" does not exist`);
    }
    this.e.catalog.dropTable(s.table);
    this.e.heaps.delete(s.table.toLowerCase());
    this.e.metas.delete(s.table.toLowerCase());
    this.e.indexes.delete(s.table.toLowerCase());
    await this.e.commitCatalog();
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  private async doDropIndex(s: DropIndexStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const meta = this.e.catalog.getIndex(s.index);
    if (!meta) {
      if (s.ifExists) return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
      throw new Error(`Index "${s.index}" does not exist`);
    }
    this.e.catalog.dropIndex(s.index);
    const tableArr = this.e.indexes.get(meta.table.toLowerCase());
    if (tableArr) {
      this.e.indexes.set(meta.table.toLowerCase(), tableArr.filter((i) => i.name.toLowerCase() !== s.index.toLowerCase()));
    }
    await this.e.commitCatalog();
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  // ---------------- DML ----------------

  private async doInsert(s: InsertStmt, snap: number): Promise<QueryResult> {
    const t0 = performance.now();
    const tKey = s.table.toLowerCase();
    const meta = this.e.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${s.table}" not found`);
    const heap = this.e.heaps.get(tKey)!;
    const schema = { name: meta.name, columns: meta.columns };

    let inserted = 0;
    for (const rawRow of s.rows) {
      const values: Value[] = new Array(meta.columns.length).fill(null);
      if (s.columns) {
        for (let i = 0; i < s.columns.length; i++) {
          const colName = s.columns[i].toLowerCase();
          const colIdx = meta.columns.findIndex((c) => c.name.toLowerCase() === colName);
          if (colIdx < 0) throw new Error(`Column "${s.columns[i]}" not found in table "${s.table}"`);
          values[colIdx] = evalExpr(rawRow[i], emptyContext);
        }
      } else {
        for (let i = 0; i < rawRow.length && i < meta.columns.length; i++) {
          values[i] = evalExpr(rawRow[i], emptyContext);
        }
      }
      // defaults
      for (let i = 0; i < meta.columns.length; i++) {
        const col = meta.columns[i];
        if (values[i] === null && col.autoIncrement) {
          values[i] = await heap.nextAutoInc();
        }
        if (values[i] === null && col.notNull) {
          throw new Error(`NOT NULL constraint failed: ${col.name}`);
        }
      }
      const coerced = coerceRow(schema, values);
      // unique check for primary key
      if (meta.primaryKey) {
        const pkCol = meta.columns.find((c) => c.name === meta.primaryKey);
        if (pkCol) {
          const pkIdx = meta.columns.indexOf(pkCol);
          const pkVal = coerced[pkIdx];
          if (pkVal !== null) {
            const key = encodeKeyValue(pkVal, pkCol.type);
            const idx = this.e.indexes.get(tKey)?.find((i) => i.columns.length === 1 && i.columns[0] === meta.primaryKey);
            if (idx) {
              const found = await idx.find(key, snap);
              if (found.found) throw new Error(`UNIQUE constraint failed: ${meta.primaryKey} = ${formatValue(pkVal)}`);
            }
          }
        }
      }
      const record = serializeRow(schema, coerced);
      const rid = await heap.nextRid();
      await heap.append(record);
      // insert into all indexes
      const idxs = this.e.indexes.get(tKey) ?? [];
      for (const idx of idxs) {
        const key = encodeCompositeIndexKey(idx.columns, coerced, meta);
        await idx.insert(key, rid);
      }
      inserted++;
    }
    return { columns: [], rows: [], rowCount: inserted, timeMs: performance.now() - t0 };
  }

  private async doUpdate(s: UpdateStmt, snap: number): Promise<QueryResult> {
    const t0 = performance.now();
    const tKey = s.table.toLowerCase();
    const meta = this.e.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${s.table}" not found`);
    const heap = this.e.heaps.get(tKey)!;
    const schema = { name: meta.name, columns: meta.columns };

    const setColIdx = new Map<string, number>();
    for (const set of s.sets) {
      const ci = meta.columns.findIndex((c) => c.name.toLowerCase() === set.column.toLowerCase());
      if (ci < 0) throw new Error(`Column "${set.column}" not found`);
      setColIdx.set(set.column.toLowerCase(), ci);
    }

    let updated = 0;
    for await (const { pageId, index, rid, record, delete: del } of heap.scan(snap)) {
      void del;
      const row = deserializeRow(schema, record);
      const ctx = rowContext({ values: row, schema: meta.columns.map((c) => c.name), tables: [] });
      if (s.where) {
        const v = evalExpr(s.where, ctx);
        if (v !== true) continue;
      }
      const newRow = [...row];
      for (const set of s.sets) {
        const ci = setColIdx.get(set.column.toLowerCase())!;
        const v = evalExpr(set.value, ctx);
        newRow[ci] = v;
      }
      const coerced = coerceRow(schema, newRow);
      // unique checks for indexed columns
      for (const idx of this.e.indexes.get(tKey) ?? []) {
        const key = encodeCompositeIndexKey(idx.columns, coerced, meta);
        const existing = await idx.find(key, snap);
        if (existing.found && existing.value !== rid) {
          throw new Error(`UNIQUE constraint failed on index ${idx.name}`);
        }
      }
      const newRec = serializeRow(schema, coerced);
      await heap.replaceSlot(pageId, index, newRec);
      // update indexes: delete old key, insert new
      for (const idx of this.e.indexes.get(tKey) ?? []) {
        const oldKey = encodeCompositeIndexKey(idx.columns, row, meta);
        await idx.delete(oldKey);
        const newKey = encodeCompositeIndexKey(idx.columns, coerced, meta);
        await idx.insert(newKey, rid);
      }
      updated++;
    }
    return { columns: [], rows: [], rowCount: updated, timeMs: performance.now() - t0 };
  }

  private async doDelete(s: DeleteStmt, snap: number): Promise<QueryResult> {
    const t0 = performance.now();
    const tKey = s.table.toLowerCase();
    const meta = this.e.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${s.table}" not found`);
    const heap = this.e.heaps.get(tKey)!;
    const schema = { name: meta.name, columns: meta.columns };

    let deleted = 0;
    for await (const { record, delete: del } of heap.scan(snap)) {
      const row = deserializeRow(schema, record);
      const ctx = rowContext({ values: row, schema: meta.columns.map((c) => c.name), tables: [] });
      let match = true;
      if (s.where) {
        const v = evalExpr(s.where, ctx);
        match = v === true;
      }
      if (match) {
        for (const idx of this.e.indexes.get(tKey) ?? []) {
          const key = encodeCompositeIndexKey(idx.columns, row, meta);
          await idx.delete(key);
        }
        await del();
        deleted++;
      }
    }
    return { columns: [], rows: [], rowCount: deleted, timeMs: performance.now() - t0 };
  }

  // ---------------- SELECT ----------------

  private async doSelect(s: SelectStmt | SetOpStmt, opts: { explain?: boolean; analyze?: boolean }, snap: number): Promise<QueryResult> {
    const t0 = performance.now();
    const tables = new Map<string, string[]>();
    const indexesMap = new Map<string, IndexInfo[]>();
    const sizes = new Map<string, number>();
    for (const meta of this.e.catalog.dataValue.tables) {
      tables.set(meta.name.toLowerCase(), meta.columns.map((c) => c.name));
      const heap = this.e.heaps.get(meta.name.toLowerCase());
      sizes.set(meta.name.toLowerCase(), heap ? await heap.recordCount() : 0);
    }
    for (const imeta of this.e.catalog.dataValue.indexes) {
      const arr = indexesMap.get(imeta.table.toLowerCase()) ?? [];
      arr.push({ name: imeta.name, columns: imeta.columns, unique: imeta.unique });
      indexesMap.set(imeta.table.toLowerCase(), arr);
    }
    const planner = new Planner({ tables, indexes: indexesMap, sizes });
    const plan = planner.planSelect(s);

    const analyzeStats: { operator: string; rows: number; timeMs: number; pages: number }[] = [];

    const ctx: ExecContext = {
      heaps: this.e.heaps,
      meta: this.e.metas,
      indexes: this.e.indexes,
      snap,
    };
    ctx.subquery = {
      run: async (
        sub: import("../sql/ast.js").SubqueryStmt,
        outer: import("../expr/evaluator.js").EvalContext | null,
      ): Promise<import("../expr/evaluator.js").SubqueryRow[]> => {
        const subPlanner = new Planner({ tables, indexes: indexesMap, sizes });
        const subPlan = subPlanner.planSelect(sub);
        const subCtx: ExecContext = { ...ctx, outer };
        const subRoot = buildOperator(subPlan, subCtx);
        const rows: import("../expr/evaluator.js").SubqueryRow[] = [];
        for (;;) {
          const r = await subRoot.next();
          if (!r) break;
          rows.push({ values: r.values, schema: r.schema });
        }
        await subRoot.close();
        return rows;
      },
    };

    if (opts.explain) {
      const { planToString } = await import("../planner/plan.js");
      return {
        columns: ["PLAN"],
        rows: [[planToString(plan)]],
        rowCount: 1,
        timeMs: performance.now() - t0,
        explain: planToString(plan),
      };
    }

    const root = buildOperator(plan, ctx);
    const outRows: Value[][] = [];
    const outCols: string[] = [];
    for (;;) {
      const row = await root.next();
      if (!row) break;
      if (outCols.length === 0) outCols.push(...row.schema);
      outRows.push([...row.values]);
    }
    await root.close();

    if (opts.analyze) {
      collectOpStats(root, analyzeStats);
      const lines = ["ANALYZE", ...analyzeStats.map((a) => `${a.operator}: ${a.rows} rows, ${a.timeMs.toFixed(2)}ms, ${a.pages} pages`)];
      return {
        columns: outCols,
        rows: outRows,
        rowCount: outRows.length,
        timeMs: performance.now() - t0,
        analyze: analyzeStats,
        explain: lines.join("\n"),
      };
    }

    return {
      columns: outCols,
      rows: outRows,
      rowCount: outRows.length,
      timeMs: performance.now() - t0,
    };
  }
}

const emptyContext = {
  getColumn(): Value {
    return null;
  },
};

function collectOpStats(root: any, out: { operator: string; rows: number; timeMs: number; pages: number }[]): void {
  const walk = (op: any) => {
    if (!op) return;
    out.push({ operator: op.constructor?.name ?? "op", rows: op.stats?.rows ?? 0, timeMs: op.stats?.timeMs ?? 0, pages: op.stats?.pages ?? 0 });
    for (const k of ["left", "right", "child"]) {
      if (op[k] && op[k].next) walk(op[k]);
    }
  };
  walk(root);
}

function encodeKeyValue(v: Value, type: SqlType): Uint8Array {
  if (v === null) return encodeKeyNull();
  switch (type) {
    case "boolean":
      return encodeKeyBoolean(v as boolean);
    case "text":
      return encodeKeyString(String(v));
    default:
      return encodeKeyNumber(Number(v));
  }
}

function encodeCompositeIndexKey(cols: string[], row: Value[], meta: TableMeta): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const col of cols) {
    const ci = meta.columns.findIndex((c) => c.name.toLowerCase() === col.toLowerCase());
    const v = ci >= 0 ? row[ci] : null;
    parts.push(encodeKeyValue(v, ci >= 0 ? meta.columns[ci].type : "text"));
  }
  if (parts.length === 1) return parts[0];
  return encodeCompositeKey(parts);
}
