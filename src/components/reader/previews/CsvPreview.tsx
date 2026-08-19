export function CsvPreview({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows;
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-body-sm tabular-nums">
        {header && (
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th
                  key={index}
                  className="sticky top-0 whitespace-nowrap border-b border-outline-variant bg-surface-container px-3 py-1.5 text-left font-semibold text-on-surface dark:border-dark-outline-variant dark:bg-dark-surface-container dark:text-dark-on-surface"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="whitespace-nowrap border-b border-outline-variant px-3 py-1.5 text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
