const XLSX = require("xlsx");
const path = require("path");
const folder = "C:\\Users\\竹内 悠馬\\OneDrive\\デスクトップ\\物件出しツール\\見積書";

["イエヤス【☆】見積書 一般.xls", "【ギガ賃貸】見積書 一般 -.xls"].forEach(f => {
  const wb = XLSX.readFile(path.join(folder, f));
  const wsName = wb.SheetNames.find(n => n.includes("見積書")) || wb.SheetNames[1];
  console.log("\n===", f, "/ シート:", wsName, "===");
  const ws = wb.Sheets[wsName];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = range.s.r; r <= Math.min(range.e.r, 40); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({r, c});
      const cell = ws[addr];
      if (cell && (cell.v !== undefined || cell.f)) {
        if (["E","F","B","C","M","N"].includes(addr[0])) {
          const val = cell.f ? `=FORMULA` : cell.v;
          console.log(`  ${addr}: ${val}`);
        }
      }
    }
  }
});
