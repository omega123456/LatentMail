declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  type SqlValue = string | number | Uint8Array | null;

  interface Database {
    run(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Database;
    exec(sql: string, params?: SqlValue[] | Record<string, SqlValue>): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsInitOptions {
    locateFile?: (filename: string) => string;
  }

  export default function initSqlJs(options?: SqlJsInitOptions): Promise<SqlJsStatic>;
  export { Database, QueryExecResult, SqlValue, SqlJsStatic };
}
