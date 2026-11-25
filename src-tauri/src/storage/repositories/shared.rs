use rusqlite::{types::Value, Connection, Result, Row};

const BIND_BATCH_SIZE: usize = 500;

pub(super) fn sql_placeholders(count: usize) -> String {
    vec!["?"; count].join(",")
}

pub(super) struct ChunkedQuery<'a, F: Fn(&str) -> String> {
    pub(super) ids: &'a [&'a str],
    pub(super) tail: &'a [&'a str],
    pub(super) sql_for_placeholders: F,
}

pub(super) struct ChunkedAccountQuery<'a> {
    pub(super) connection: &'a Connection,
    pub(super) account_id: &'a str,
}

impl<'a> ChunkedAccountQuery<'a> {
    pub(super) fn new(connection: &'a Connection, account_id: &'a str) -> Self {
        Self {
            connection: connection,
            account_id: account_id,
        }
    }

    pub(super) fn query<Item>(
        &self,
        spec: ChunkedQuery<'_, impl Fn(&str) -> String>,
        mut map_row: impl FnMut(&Row<'_>) -> Result<Item>,
    ) -> Result<Vec<Item>> {
        let mut results = Vec::new();
        for chunk in spec.ids.chunks(BIND_BATCH_SIZE) {
            let placeholders = sql_placeholders(chunk.len());
            let sql = (spec.sql_for_placeholders)(&placeholders);
            let mut statement = self.connection.prepare(&sql)?;
            let parameters = std::iter::once(self.account_id)
                .chain(chunk.iter().copied())
                .chain(spec.tail.iter().copied());
            let chunk_rows = statement
                .query_map(rusqlite::params_from_iter(parameters), &mut map_row)?
                .collect::<Result<Vec<_>>>()?;
            results.extend(chunk_rows);
        }
        Ok(results)
    }
}

pub(super) struct StringPair {
    pub(super) first: String,
    pub(super) second: String,
}

pub(super) fn string_pair_row(row: &Row<'_>) -> Result<StringPair> {
    Ok(StringPair {
        first: row.get::<_, String>(0)?,
        second: row.get::<_, String>(1)?,
    })
}

pub(super) struct SqlClause {
    pub(super) sql: String,
    pub(super) values: Vec<Value>,
}
