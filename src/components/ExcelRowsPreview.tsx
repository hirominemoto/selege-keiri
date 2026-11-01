import type { ExcelCell, ExcelRows } from "@/lib/excelRows";

const show = (v: ExcelCell) => {
  if (v === null || v === "") return <span className="muted">（空）</span>;
  if (typeof v === "number") return v.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.replaceAll("-", "/");
  return v;
};

/** 「この請求を入力すると、Excelにこう書かれます」：3つのExcelに足す行を、列の並びのまま見せる */
export function ExcelRowsPreview({ books }: { books: ExcelRows[] }) {
  return (
    <>
      {books.map((b) => (
        <div key={b.book} className="excel-book">
          <h3>
            {b.book} <span className="muted small">シート「{b.sheet}」</span>
          </h3>
          {b.sheetNote && <p className="small muted">{b.sheetNote}</p>}
          <div className="table-wrap">
            <table className="excel-table">
              <thead>
                <tr>
                  {b.columns.map((c, i) => (
                    <th key={i}>
                      {c.col && <span className="excel-col">{c.col}</span>}
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={typeof v === "number" ? "num nowrap" : undefined}>
                        {show(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="small muted excel-notes">
            {b.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
