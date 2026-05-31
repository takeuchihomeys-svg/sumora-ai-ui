const XLSX = require("xlsx");
const path = require("path");

const file = path.join("C:\\Users\\竹内 悠馬\\OneDrive\\デスクトップ\\物件出しツール\\見積書", "【スモラ】見積書 一般.xls");
const wb = XLSX.readFile(file);

console.log("=== シート名一覧 ===");
wb.SheetNames.forEach((n, i) => console.log(i, n));

// 見積書シートを解析
const wsName = wb.SheetNames.find(n => n.includes("見積書")) || wb.SheetNames[1];
console.log("\n=== 使用シート:", wsName, "===");
const ws = wb.Sheets[wsName];

// 値が入っているセルをすべて出力
const range = XLSX.utils.decode_range(ws["!ref"]);
for (let r = range.s.r; r <= Math.min(range.e.r, 45); r++) {
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({r, c});
    const cell = ws[addr];
    if (cell && (cell.v !== undefined || cell.f)) {
      const val = cell.f ? `=FORMULA: ${cell.f}` : cell.v;
      console.log(`${addr}: ${val}`);
    }
  }
}
