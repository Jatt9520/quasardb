import { BufferPool } from "../storage/bufferPool.js";
import { Catalog, TableMeta, IndexMeta } from "../storage/catalog.js";
import { BtreeIndex, compareKeys, encodeCompositeKey, encodeKeyBoolean, encodeKeyNull, encodeKeyNumber, encodeKeyString, keyToString } from "../btree/btree.js";
import { TableHeap } from "../storage/tableHeap.js";
import {
  ColumnDef, DeleteStmt, Expr, InsertStmt, SelectStmt, SetOpStmt, SqlType, Statement,
  UpdateStmt, CreateTableStmt, CreateIndexStmt, DropTableStmt, DropIndexStmt,
} from "../sql/ast.js";
import { Planner } from "../planner/planner.js";
import { buildOperator, ExecContext, Row, rowContext } from "../executor/executor.js";
import { evalExpr } from "../expr/evaluator.js";
import { Value, coerceToType, formatValue } from "../expr/value.js";
import { coerceRow, deserializeRow, serializeRow } from "../storage/record.js";
import { FileDisk } from "../storage/disk.js";

export interface QueryResult {
  columns: string[];
  rows: Value[][];
  rowCount: number;
  timeMs: number;
  explain?: string;
  analyze?: { operator: string; rows: number; timeMs: number; pages: number }[];
}

export class Engine {
  private pool: BufferPool;
  private catalog: Catalog;
  private heaps = new Map<string, TableHeap>();
  private metas = new Map<string, TableMeta>();
  private indexes = new Map<string, BtreeIndex[]>();

  private constructor(pool: BufferPool, catalog: Catalog) {
    this.pool = pool;
    this.catalog = catalog;
    this.loadState();
  }

  static async create(path: string): Promise<Engine> {
    const disk = await FileDisk.open(path);
    const pool = new BufferPool(disk, 512);
    await pool.initAllocator();
    const catalog = await Catalog.create(pool);
    const engine = new Engine(pool, catalog);
    await engine.commitCatalog();
    return engine;
  }

  static async open(path: string): Promise<Engine> {
    const disk = await FileDisk.open(path);
    const pool = new BufferPool(disk, 512);
    await pool.initAllocator();
    const catalog = await Catalog.open(pool);
    return new Engine(pool, catalog);
  }

  private loadState(): void {
    for (const t of this.catalog.dataValue.tables) {
      this.metas.set(t.name.toLowerCase(), t);
      this.heaps.set(t.name.toLowerCase(), new TableHeap(t.name, t.headerPageId, this.pool));
    }
    for (const i of this.catalog.dataValue.indexes) {
      const idx = new BtreeIndex(i.name, i.table, i.columns, i.metaPageId, this.pool, i.unique);
      const arr = this.indexes.get(i.table.toLowerCase()) ?? [];
      arr.push(idx);
      this.indexes.set(i.table.toLowerCase(), arr);
    }
  }

  private async commitCatalog(): Promise<void> {
    await this.catalog.persist();
  }

  private async syncAll(): Promise<void> {
    await this.pool.flushAll();
    await this.catalog.persist();
  }

  get bufferPool(): BufferPool {
    return this.pool;
  }

  get catalogData() {
    return this.catalog.dataValue;
  }

  async close(): Promise<void> {
    await this.syncAll();
  }

  /** Execute a prepared statement; returns query result. */
  async execute(statement: Statement, opts: { explain?: boolean; analyze?: boolean } = {}): Promise<QueryResult> {
    const t0 = performance.now();
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
        return this.doInsert(statement);
      case "update":
        return this.doUpdate(statement);
      case "delete":
        return this.doDelete(statement);
      case "select":
        return this.doSelect(statement, opts);
      case "setop":
        return this.doSelect(statement, opts);
    }
  }

  // ---------------- DDL ----------------

  private async doCreateTable(s: CreateTableStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const name = s.table.toLowerCase();
    if (this.catalog.getTable(name)) {
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
    const heap = await TableHeap.create(name, this.pool);
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
    this.catalog.addTable(meta);
    await this.commitCatalog();
    this.heaps.set(name, heap);
    this.metas.set(name, meta);
    // auto-create unique index on primary key
    if (pk) {
      await this.buildIndex(`${name}__pk`, name, [pk], true);
    }
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  private async doCreateIndex(s: CreateIndexStmt): Promise<QueryResult> {
    const t0 = performance.now();
    if (this.catalog.getIndex(s.index.toLowerCase())) {
      if (s.ifNotExists) return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
      throw new Error(`Index "${s.index}" already exists`);
    }
    await this.buildIndex(s.index, s.table, s.cols, false);
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  private async buildIndex(name: string, table: string, cols: string[], unique: boolean): Promise<void> {
    const tKey = table.toLowerCase();
    const meta = this.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${table}" not found`);
    const idx = await BtreeIndex.create(name.toLowerCase(), table, cols, this.pool, unique);
    const heap = this.heaps.get(tKey)!;
    const schema = { name: meta.name, columns: meta.columns };
    let good = true;
    let rid = 1;
    for await (const { record } of heap.scan()) {
      const row = deserializeRow(schema, record);
      const key = encodeCompositeIndexKey(cols, row, meta);
      try {
        await idx.insert(key, rid);
      } catch (e) {
        good = false;
        throw e;
      }
      rid++;
    }
    if (!good) throw new Error("Index build failed");
    const imeta: IndexMeta = {
      name: name.toLowerCase(),
      table,
      columns: cols,
      metaPageId: idx.metaPageIdValue,
      unique,
    };
    this.catalog.addIndex(imeta);
    const arr = this.indexes.get(tKey) ?? [];
    arr.push(idx);
    this.indexes.set(tKey, arr);
    await this.commitCatalog();
  }

  private async doDropTable(s: DropTableStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const meta = this.catalog.getTable(s.table);
    if (!meta) {
      if (s.ifExists) return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
      throw new Error(`Table "${s.table}" does not exist`);
    }
    this.catalog.dropTable(s.table);
    this.heaps.delete(s.table.toLowerCase());
    this.metas.delete(s.table.toLowerCase());
    this.indexes.delete(s.table.toLowerCase());
    await this.commitCatalog();
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  private async doDropIndex(s: DropIndexStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const meta = this.catalog.getIndex(s.index);
    if (!meta) {
      if (s.ifExists) return { columns: [], rows: [], rowCount: 0, timeMs: 0 };
      throw new Error(`Index "${s.index}" does not exist`);
    }
    this.catalog.dropIndex(s.index);
    const tableArr = this.indexes.get(meta.table.toLowerCase());
    if (tableArr) {
      this.indexes.set(meta.table.toLowerCase(), tableArr.filter((i) => i.name.toLowerCase() !== s.index.toLowerCase()));
    }
    await this.commitCatalog();
    return { columns: [], rows: [], rowCount: 0, timeMs: performance.now() - t0 };
  }

  // ---------------- DML ----------------

  private async doInsert(s: InsertStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const tKey = s.table.toLowerCase();
    const meta = this.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${s.table}" not found`);
    const heap = this.heaps.get(tKey)!;
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
            const idx = this.indexes.get(tKey)?.find((i) => i.columns.length === 1 && i.columns[0] === meta.primaryKey);
            if (idx) {
              const found = await idx.find(key);
              if (found.found) throw new Error(`UNIQUE constraint failed: ${meta.primaryKey} = ${formatValue(pkVal)}`);
            }
          }
        }
      }
      const record = serializeRow(schema, coerced);
      await heap.append(record);
      // insert into all indexes
      const idxs = this.indexes.get(tKey) ?? [];
      const rid = await heap.recordCount();
      for (const idx of idxs) {
        const key = encodeCompositeIndexKey(idx.columns, coerced, meta);
        await idx.insert(key, rid);
      }
      inserted++;
    }
    return { columns: [], rows: [], rowCount: inserted, timeMs: performance.now() - t0 };
  }

  private async doUpdate(s: UpdateStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const tKey = s.table.toLowerCase();
    const meta = this.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${s.table}" not found`);
    const heap = this.heaps.get(tKey)!;
    const schema = { name: meta.name, columns: meta.columns };

    const setColIdx = new Map<string, number>();
    for (const set of s.sets) {
      const ci = meta.columns.findIndex((c) => c.name.toLowerCase() === set.column.toLowerCase());
      if (ci < 0) throw new Error(`Column "${set.column}" not found`);
      setColIdx.set(set.column.toLowerCase(), ci);
    }

    let updated = 0;
    let rid = 1;
    for await (const { pageId, index, record, delete: del } of heap.scan()) {
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
      for (const idx of this.indexes.get(tKey) ?? []) {
        const key = encodeCompositeIndexKey(idx.columns, coerced, meta);
        const existing = await idx.find(key);
        if (existing.found && existing.value !== rid) {
          throw new Error(`UNIQUE constraint failed on index ${idx.name}`);
        }
      }
      const newRec = serializeRow(schema, coerced);
      await heap.replaceSlot(pageId, index, newRec);
      // update indexes: delete old key, insert new
      for (const idx of this.indexes.get(tKey) ?? []) {
        const oldKey = encodeCompositeIndexKey(idx.columns, row, meta);
        await idx.delete(oldKey);
        const newKey = encodeCompositeIndexKey(idx.columns, coerced, meta);
        await idx.insert(newKey, rid);
      }
      updated++;
      rid++;
    }
    return { columns: [], rows: [], rowCount: updated, timeMs: performance.now() - t0 };
  }

  private async doDelete(s: DeleteStmt): Promise<QueryResult> {
    const t0 = performance.now();
    const tKey = s.table.toLowerCase();
    const meta = this.catalog.getTable(tKey);
    if (!meta) throw new Error(`Table "${s.table}" not found`);
    const heap = this.heaps.get(tKey)!;
    const schema = { name: meta.name, columns: meta.columns };

    let deleted = 0;
    let rid = 1;
    for await (const { pageId, index, record, delete: del } of heap.scan()) {
      const row = deserializeRow(schema, record);
      const ctx = rowContext({ values: row, schema: meta.columns.map((c) => c.name), tables: [] });
      let match = true;
      if (s.where) {
        const v = evalExpr(s.where, ctx);
        match = v === true;
      }
      if (match) {
        for (const idx of this.indexes.get(tKey) ?? []) {
          const key = encodeCompositeIndexKey(idx.columns, row, meta);
          await idx.delete(key);
        }
        await del();
        deleted++;
      }
      rid++;
    }
    return { columns: [], rows: [], rowCount: deleted, timeMs: performance.now() - t0 };
  }

  // ---------------- SELECT ----------------

  private async doSelect(s: SelectStmt | SetOpStmt, opts: { explain?: boolean; analyze?: boolean }): Promise<QueryResult> {
    const t0 = performance.now();
    const tables = new Map<string, string[]>();
    for (const meta of this.catalog.dataValue.tables) {
      tables.set(meta.name.toLowerCase(), meta.columns.map((c) => c.name));
    }
    const planner = new Planner({ tables });
    const plan = planner.planSelect(s);

    const analyzeStats: { operator: string; rows: number; timeMs: number; pages: number }[] = [];

    const ctx: ExecContext = {
      heaps: this.heaps,
      meta: this.metas,
      indexes: this.indexes,
    };
    ctx.subquery = {
      run: async (
        sub: import("../sql/ast.js").SubqueryStmt,
        outer: import("../expr/evaluator.js").EvalContext | null,
      ): Promise<import("../expr/evaluator.js").SubqueryRow[]> => {
        const subPlanner = new Planner({ tables });
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

export { keyToString, compareKeys };
