# QuasarDB

A from-scratch relational database engine written in TypeScript, with zero
runtime dependencies. QuasarDB is a learning-first implementation of the full
database stack: SQL front end, query optimization, execution engine, page-based
storage, B+tree indexes, and transactions — all in ~7.5k lines of readable code.

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
- Vector search: `VECTOR` column type, `[1, 2, -3]` literals, `<->`
  euclidean distance, and a dedicated KNN fast path
  (`ORDER BY col <-> [q] LIMIT k`, visible as a `knn` node in `EXPLAIN`)
- Time travel: `SELECT ... AS OF <xid>` reads a consistent snapshot of a
  past commit (the engine keeps pre-images for the most recent 64 commits)
- Functions: `abs`, `round`, `floor`, `ceil`, `upper`, `lower`, `length`,
  `trim`, `substr`, `replace`, `coalesce`, `nullif`, `greatest`, `least`,
  `concat`, `pow`, `sqrt`, `exp`, `ln`, `log10`, `sign`, ... plus aggregates
  `count`, `sum`, `avg`, `min`, `max`
- Types: `INT`, `BIGINT`, `REAL`, `TEXT`, `BOOLEAN`, `VECTOR`
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
- B+tree page version chains in the buffer pool for MVCC snapshots
- Append-only write-ahead log (JSON lines) with fsync-on-commit durability
  and crash recovery (`src/wal`)

**Transactions & durability**
- `BEGIN` / `COMMIT` / `ROLLBACK` with per-session transactions
- MVCC: buffer-pool page version chains give every session its own consistent
  read snapshot; writers never block readers (`src/engine/session.ts`)
- Write-ahead log (`<db>.wal`, JSON lines): statement records are buffered,
  the commit marker is always fsynced — a transaction is durable once its
  commit marker hits disk (`src/wal`)
- Crash recovery: on open, committed transactions past the durable watermark
  are replayed and the log is truncated (`src/engine/engine.ts#recoverWals`)
- `npm run crash-demo` kills the process mid-commit and verifies recovery
- WAL replication: a follower tails the master's `<db>.wal` and replays every
  committed transaction onto its own engine; the replica rebuilds itself when
  the master log is truncated (`src/replication`)
- Time travel: every commit is retained as an MVCC snapshot for a rolling
  window of 64 transactions, so `SELECT ... AS OF <xid>` can rewind the
  database to any commit inside the window (`src/engine/timeTravel.test.ts`)

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

# simulate a crash mid-commit, then verify WAL recovery restores the data
npm run crash-demo

# run a replica that tails another terminal's master (see below)
npm run replicate -- master.db.wal replica.db
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

-- vector search: nearest neighbors by euclidean distance
CREATE TABLE docs (id INT PRIMARY KEY, title TEXT, emb VECTOR);
INSERT INTO docs VALUES (1, 'cat', [0.1, 0.9, 0.2]), (2, 'dog', [0.2, 0.8, 0.1]);
SELECT title FROM docs ORDER BY emb <-> [0.1, 0.8, 0.2] LIMIT 1;  -- 'dog'

-- time travel: read the database as of an earlier commit
SELECT ... AS OF <xid>;  -- xid = any transaction id inside the 64-commit window
```

Run a master and a live replica in two terminals:

```bash
npm run repl -- master.db          # terminal 1: writes here
npm run replicate -- master.db.wal replica.db   # terminal 2: tails & replays
```

Every committed write in terminal 1 lands in `replica.db` within the replica's
poll interval (250 ms).

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
  plus, around the engine:
     ├─ sessions (src/engine/session.ts) — per-session MVCC snapshots
     └─ WAL (src/wal/wal.ts) — fsync-on-commit log + recovery replay
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
  engine/    Engine API (execute, transactions, MVCC sessions, WAL recovery,
             DDL/DML), integration tests
  storage/   pages, disk, buffer pool, table heap, catalog, record (de)serialization
  btree/     B+tree index implementation
  wal/       write-ahead log with commit-fsync durability
  replication/ WAL tailing follower (master-replica replication)
  cli/       REPL, crash demo, replica follower
  server/    PostgreSQL wire protocol server
```

## Testing

```bash
npm test        # vitest runs the engine integration suite (engine.test.ts),
                # WAL tests (wal.test.ts), replication (replicator.test.ts),
                # time-travel (timeTravel.test.ts), vector search
                # (vector.test.ts), and the B+tree test suite
                # (delta1-5, insertOnly, bisect, copyTest, render)
```

## Status / roadmap

- [x] Core engine: SQL, storage, indexes, REPL, wire server
- [x] MVCC: per-session snapshot isolation via buffer-pool page version chains
- [x] Write-ahead log (WAL) for crash-safe durability, with recovery replay
      and a crash demo
- [x] Time travel: `SELECT ... AS OF <xid>` over retained MVCC snapshots
- [x] Master-replica replication by WAL tailing (`npm run replicate`)
- [x] Vector search: `VECTOR` type, `<->` distance, KNN plan node
- [ ] Cost-based optimizer; hash / sort-merge joins
- [ ] `LIKE` / range index ranges for non-equality predicates
- [ ] Extended query protocol (Parse/Bind/Execute) in the wire server

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Copyright 2026 Jatt9520