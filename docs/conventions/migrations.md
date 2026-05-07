# Migrations Convention

> task-047 iter0 (MED-046-3 carry-over): index 생성 시 lock 회피 가이드.

## 인덱스 생성 (`CREATE INDEX`) 규칙

### Populated 테이블

이미 row 가 있는 (=production 트래픽이 도달한) 테이블에 인덱스 추가
시 반드시 `CREATE INDEX CONCURRENTLY`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TableName_columnName_idx"
  ON "TableName" ("columnName");
```

이유:

- 기본 `CREATE INDEX` 는 `SHARE LOCK` 을 잡아 동시 INSERT/UPDATE 차단
- production 트래픽 / online deploy 흐름에서 정지 발생
- `CONCURRENTLY` 는 두 단계 스캔 + 자동 retry 로 lock 없이 인덱스 빌드

### 새 테이블 (`CREATE TABLE` 와 동시)

`CREATE TABLE` 직후 인덱스 추가는 빈 테이블이라 lock 비용 0 →
`CREATE INDEX` (CONCURRENTLY 없이) 도 무해. 단, 같은 transaction 안에
넣어야 atomic.

```sql
CREATE TABLE "NewTable" (...);
CREATE INDEX "NewTable_columnName_idx" ON "NewTable" ("columnName");
```

### Prisma `@@index` 제약

Prisma 의 `@@index([...])` 는 항상 plain `CREATE INDEX` 를 emit. 따라서:

- 새 테이블: `@@index` 그대로 OK
- 기존 테이블: `prisma migrate diff` 산출물의 `CREATE INDEX` 를 raw SQL
  migration 으로 옮기고 `CONCURRENTLY` 추가
  - 또는 별도 `IF NOT EXISTS` `CONCURRENTLY` migration 작성 + Prisma
    schema 만 갱신 (Prisma 가 이미 존재하는 인덱스를 detect 하면 skip)

## Reversible 원칙

모든 schema migration 은 reversible — `down` migration 또는 동등 SQL
주석 보유. destructive (DROP COLUMN / DROP TABLE) 도 backup 절차 명시.

`CREATE INDEX CONCURRENTLY` 는 transaction 안에서 실행 안 됨 — Prisma
의 `prisma migrate deploy` 가 single-statement migration 으로 처리.

## Partial / functional index

Prisma `@@index` 가 partial WHERE / functional 미지원이면 raw SQL
migration 으로 별도 추가. 예: 044 의 pinned messages partial index,
014 의 thread reply partial index.

## 참고

- PostgreSQL docs: [CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)
- 본 가이드 도입 trigger: 046 reviewer carry-over (MED-046-3)
- 적용 시점: 047 iter0 부터, 향후 모든 신규 migration
