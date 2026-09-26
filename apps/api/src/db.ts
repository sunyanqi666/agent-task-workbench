import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * 打开数据库并执行版本化迁移（migrations/NNN_*.sql，按文件名序）。
 * 迁移进度记录在 PRAGMA user_version；脚本使用幂等语句，可在全新数据库上重复执行。
 */
export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
}

function applyMigrations(db: DatabaseSync): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  let current = version;
  for (const file of files) {
    const target = Number(file.split('_')[0]);
    if (Number.isNaN(target) || target <= current) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // 迁移语句与 user_version 更新必须同事务：中断后重启动不会重复执行已应用的迁移
    withTransaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${target}`);
    });
    current = target;
  }
}

/**
 * 可重入事务：已在事务中时直接参与外层事务（内层异常向上传播，由最外层统一回滚），
 * 否则开启新事务（异常时回滚并原样抛出）。
 * SQLite 无嵌套事务，服务层（任务 + 账本）组合操作时内层必须复用外层事务而非再次 BEGIN。
 */
const inTransaction = new WeakSet<DatabaseSync>();

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (inTransaction.has(db)) return fn();
  db.exec('BEGIN');
  inTransaction.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    inTransaction.delete(db);
  }
}

/** 便捷查询：all 结果按调用方给定类型断言 */
export function queryAll<T>(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number)[]
): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/** 便捷查询：get 单行结果 */
export function queryOne<T>(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number)[]
): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
