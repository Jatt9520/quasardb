# QuasarDB

A from-scratch relational database engine written in TypeScript, with zero
runtime dependencies. QuasarDB is a learning-first implementation of the full
database stack: SQL front end, query optimization, execution engine, page-based
storage, B+tree indexes, and transactions — all in ~6k lines of readable code.

## Features

**SQL**
- Full statement set: `CREATE TABLE`, `CREATE INDEX`, `DROP TABLE`, `DROP INDEX`
- `INSERT`, `UPDATE`, `DELETE`, `SELECT` with `WHERE`, `GROUP BY`, `HAVING`,
  `ORDER BY`, `LIMIT`/`OFFSET`, `DISTINCT`
- Joins: `INNER`, `LEFT`, `RIGHT`, `CROSS`
- Set operations: `UNION [ALL]`, `INTERSECT [ALL]`, `EXCEPT [ALL]`
- Subqueries: scalar, `EXISTS`, `IN`, and derived tables in `FROM`
- Expressions: arithmetic, comparison, logical, `CASE`, `CAST`, `LIKE`,
  `BETWEEN`, `IS NULL`, string concatenation (`||`)
- Functions: `abs`, `round`, `floor`, `ceil`, `upper`, `lower`, `length`,
  `trim`, `substr`, `replace`, `coalesce`, `nullif`, `greatest`, `least`,
  `concat`, `pow`, `sqrt`, `exp`, `ln`, `log10`, `sign`, ... plus aggregates
  `count`, `sum`, `avg`, `min`, `max`
- Types: `INT`, `BIGINT`, `REAL`, `TEXT`, `BOOLEAN`
- Constraints: `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `AUTO INCREMENT`, `DEFAULT`
- `EXPLAIN` / `ANALYZE` for query plans and per-operator stats

**Engine**
- Hand-written lexer, recursive-descent parser, and typed AST (`src/sql`)
- Rule-based query planner with predicate push-down, join reordering, and
  index access-path selection (`src/planner`)
- Volcano-style pull iterator executor (`src/executor`)
- Expression parser & evaluator with subquery hooks (`src/expr`)
- B+tree multi-column indexes with ordered, merge-sortable composite keys
  (`src/btree`)

**Storage**
- 4 KiB page-based disk files with page-type markers (`QUDB` magic)
- LRU buffer pool with pinning, dirty tracking, and stats
  (default 512 pages)
- Slotted-page table heaps with slot reuse and AUTO INCREMENT counters
  (`src/storage`)
- Persistent catalog (schema metadata) stored in-page

**Transactions**
- `BEGIN` / `COMMIT` / `ROLLBACK`
- Snapshot-based isolation: the catalog is snapshotted and page writes are
  tracked in an undo log, so `ROLLBACK` restores pre-transaction state

**Clients**
- Interactive REPL (`quasar`) with `.tables`, `.indexes`, `.stats`, `.verify`
  meta commands and pretty-printed result tables (`src/cli`)
- PostgreSQL wire-protocol server (protocol 3.0, simple-query mode) — works
  with `psql` and scripted clients (`src/server`)

## Quick start

Requires Node.js >= 20.

```bash
npm install

# run the tests
npm test

# start the interactive REPL (creates quasar.db, or opens it if it exists)
npm run repl            # or: npm run repl -- mydb.db

# start the PostgreSQL-compatible server (default port 5432)
npm run server
```

Try it:

```sql
CREATE TABLE users (
  id   INT PRIMARY KEY AUTO INCREMENT,
  name TEXT NOT NULL,
  age  INT,
  active BOOLEAN DEFAULT true
);

INSERT INTO users (name, age) VALUES ('alice', 30), ('bob', 25);

SELECT name, age FROM users WHERE age > 26 ORDER BY age DESC;

EXPLAIN SELECT * FROM users;
```

Use `psql -h localhost -p 5432` to connect to the wire server.

## Architecture

```
SQL text
  └─ lexer (src/sql/lexer.ts)
       └─ parser (src/sql/parser.ts) → AST (src/sql/ast.ts)
            └─ planner (src/planner/planner.ts) → physical plan (src/planner/plan.ts)
                 └─ executor (src/executor/executor.ts) — pull-based operators
                      └─ engine (src/engine/engine.ts) — DDL/DML/transaction glue
                           ├─ table heap (src/storage/tableHeap.ts)
                           ├─ buffer pool (src/storage/bufferPool.ts) → disk (src/storage/disk.ts)
                           ├─ catalog (src/storage/catalog.ts)
                           └─ B+tree indexes (src/btree/btree.ts)
```

The flow mirrors a real database:

1. The lexer and parser tokenize and parse SQL into a typed AST.
2. The planner turns the AST into a physical operator tree, choosing index
   scans when predicates match the leading columns of an index, pushing down
   WHERE conjuncts and reordering joins by estimated size.
3. The executor pulls rows through operators (scan → join → filter → group →
   project → distinct → sort → limit).
4. The engine serializes rows into the table heap and maintains B+tree index
   entries, all routed through the buffer pool which manages pinned, dirty,
   and evicted pages against the on-disk file.

## Project layout

```
src/
  sql/       lexer, parser, AST
  expr/      expression evaluation, value coercion & comparison
  planner/   query planning, physical plan nodes
  executor/  operator execution
  engine/    Engine API (execute, transactions, DDL/DML), integration tests
  storage/   pages, disk, buffer pool, table heap, catalog, record (de)serialization
  btree/     B+tree index implementation
  cli/       REPL
  server/    PostgreSQL wire protocol server
```

## Testing

```bash
npm test        # vitest runs engine.test.ts and pgWire.test.ts
```

## Status / roadmap

- [x] Core engine: SQL, storage, indexes, transactions, REPL, wire server
- [ ] Write-ahead log (WAL) for crash-safe durability
- [ ] True multi-version concurrency control (MVCC) / concurrent sessions
- [ ] Cost-based optimizer; hash / sort-merge joins
- [ ] `LIKE` / range index ranges for non-equality predicates
- [ ] Extended query protocol (Parse/Bind/Execute) in the wire server

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Copyright 2026 Jatt9520