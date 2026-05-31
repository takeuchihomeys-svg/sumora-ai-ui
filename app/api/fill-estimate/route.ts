import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import path from "path";
import fs from "fs";

type Account = "sumora" | "ieyasu" | "giga";

const TEMPLATE_FILES: Record<Account, string> = {
  sumora: "sumora-estimate.xls",
  ieyasu: "ieyasu-estimate.xls",
  giga: "giga-estimate.xls",
};

const ACCOUNT_LABELS: Record<Account, string> = {
  sumora: "スモラ",
  ieyasu: "イエヤス",
  giga: "ギガ賃貸",
};

type ItemData = {
  propertyName: string;
  roomNumber: string;
  customerName: string;
  assignee: string;
  moveInDate: string;
  moveInMonth: number;
  moveInDay: number;
  moveInMonthDays: number;
  nextMonth: number;
  nextYear: number;
  rent: number;
  managementFee: number;
  waterFee: number;
  shikikin: number;
  reikin: number;
  hoshokikin: number;
  commission: number;
  commissionTax: number;
  parkingCommission: number;
  parkingCommissionTax: number;
  guarantee: number;
  insurance: number;
  keyExchange: number;
  cleaning: number;
  parkingDeposit: number;
  parkingMonthly: number;
  otherItems: Array<{ item: string; amount: number }>;
  discountAmount: number;
  discountNote: string;
  nextRent: number;
  nextManagementFee: number;
  nextWaterFee: number;
};

function setCellValue(ws: XLSX.WorkSheet, cellAddr: string, value: string | number) {
  const type = typeof value === "number" ? "n" : "s";
  ws[cellAddr] = { v: value, t: type };

  if (ws["!ref"]) {
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const cell = XLSX.utils.decode_cell(cellAddr);
    range.s.r = Math.min(range.s.r, cell.r);
    range.s.c = Math.min(range.s.c, cell.c);
    range.e.r = Math.max(range.e.r, cell.r);
    range.e.c = Math.max(range.e.c, cell.c);
    ws["!ref"] = XLSX.utils.encode_range(range);
  } else {
    ws["!ref"] = `${cellAddr}:${cellAddr}`;
  }
}

// 数式セルのキャッシュ値だけ更新（数式文字列は保持）
function updateCachedValue(ws: XLSX.WorkSheet, cellAddr: string, value: number) {
  if (ws[cellAddr]) {
    ws[cellAddr].v = value;
  } else {
    ws[cellAddr] = { v: value, t: "n" };
  }
}

function findTemplatePath(templateFile: string): string | null {
  const candidates = [
    path.join(process.cwd(), "public", "templates", templateFile),
    path.join(process.cwd(), ".next", "server", "public", "templates", templateFile),
    path.join("/var/task", "public", "templates", templateFile),
    path.join("/var/task", ".next", "server", "public", "templates", templateFile),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fillEstimateSheet(ws: XLSX.WorkSheet, d: ItemData, account: Account): void {
  // ── 物件情報（右上）
  setCellValue(ws, "M8", d.propertyName || "");
  setCellValue(ws, "N9", d.roomNumber || "");
  setCellValue(ws, "M10", d.customerName || "");

  // ── 契約条件（右側列 L〜N）
  setCellValue(ws, "M12", d.hoshokikin || 0);    // 保証金
  setCellValue(ws, "M13", d.shikikin || 0);       // 敷金
  setCellValue(ws, "M14", d.reikin || 0);         // 礼金
  setCellValue(ws, "M15", d.rent || 0);           // 家賃
  setCellValue(ws, "M16", d.managementFee || 0);  // 共益費
  setCellValue(ws, "M19", d.parkingDeposit || 0); // 駐保証金

  // ── 固定上段費用（E=スモラ列、F=一般列）
  setCellValue(ws, "E11", d.shikikin || 0);
  setCellValue(ws, "F11", d.shikikin || 0);
  setCellValue(ws, "E12", d.reikin || 0);
  setCellValue(ws, "F12", d.reikin || 0);
  const nextRent = d.nextRent || d.rent || 0;
  const nextMgmt = d.nextManagementFee || d.managementFee || 0;
  setCellValue(ws, "E13", nextRent);
  setCellValue(ws, "F13", nextRent);
  setCellValue(ws, "E14", nextMgmt);
  setCellValue(ws, "F14", nextMgmt);

  // ── 日割り計算
  const moveInDay = d.moveInDay || 1;
  const monthDays = d.moveInMonthDays || 30;
  const proratedDays = monthDays - moveInDay + 1;
  const prorated = (amount: number) =>
    amount ? Math.round((amount / monthDays) * proratedDays) : 0;
  const proratedRent = prorated(d.rent);
  const proratedMgmt = prorated(d.managementFee);
  const proratedWater = prorated(d.waterFee);

  // ── 動的項目（行15〜24、テンプレートの空き行に順番に書き込む）
  type DynItem = { label: string; amount: number };
  const dynamicItems: DynItem[] = [];

  if (proratedRent > 0)
    dynamicItems.push({ label: `日割り家賃（${proratedDays}日分）`, amount: proratedRent });
  if (proratedMgmt > 0)
    dynamicItems.push({ label: `日割り共益費（${proratedDays}日分）`, amount: proratedMgmt });
  if (proratedWater > 0)
    dynamicItems.push({ label: `日割り水道代（${proratedDays}日分）`, amount: proratedWater });
  if (d.keyExchange)
    dynamicItems.push({ label: "鍵交換代", amount: d.keyExchange });
  const parkingTotal = (d.parkingCommission || 0) + (d.parkingCommissionTax || 0);
  if (parkingTotal > 0)
    dynamicItems.push({ label: "駐車場仲介手数料", amount: parkingTotal });
  if (d.parkingMonthly)
    dynamicItems.push({ label: "翌月駐車場代", amount: d.parkingMonthly });
  for (const oi of d.otherItems || []) {
    if (oi.item && oi.amount > 0)
      dynamicItems.push({ label: oi.item, amount: oi.amount });
  }

  for (let i = 0; i < Math.min(dynamicItems.length, 10); i++) {
    const row = 15 + i;
    setCellValue(ws, `B${row}`, dynamicItems[i].label);
    setCellValue(ws, `E${row}`, dynamicItems[i].amount);
    setCellValue(ws, `F${row}`, dynamicItems[i].amount);
  }

  // ── 固定下段費用（E=スモラ実費、F=一般費用）
  setCellValue(ws, "E25", d.cleaning || 0);
  setCellValue(ws, "F25", d.cleaning || 0);
  setCellValue(ws, "E26", d.guarantee || 0);
  setCellValue(ws, "F26", d.guarantee || 0);
  setCellValue(ws, "E27", d.insurance || 0);
  setCellValue(ws, "F27", d.insurance || 0);

  // 仲介手数料（E=スモラ実費、F=一般1ヶ月分家賃相当）
  setCellValue(ws, "E28", d.commission || 0);
  setCellValue(ws, "F28", d.rent || 0);
  setCellValue(ws, "E29", d.commissionTax || 0);
  setCellValue(ws, "F29", Math.round((d.rent || 0) * 0.1));

  // スモ割 / イエヤス割（ラベルはテンプレートに記載済み）
  const discountVal = d.discountAmount ? -(d.discountAmount) : 0;
  setCellValue(ws, "E30", discountVal);

  // ── 数式セルのキャッシュ値を更新
  // （保護ビューで開いた際も正しい値を表示するため）

  // E32 = SUM(E10:E31)
  let e32 = 0;
  e32 += (d.shikikin || 0);        // E11
  e32 += (d.reikin || 0);          // E12
  e32 += nextRent;                   // E13
  e32 += nextMgmt;                   // E14
  for (const item of dynamicItems) e32 += item.amount; // E15-E24
  e32 += (d.cleaning || 0);         // E25
  e32 += (d.guarantee || 0);        // E26
  e32 += (d.insurance || 0);        // E27
  e32 += (d.commission || 0);       // E28
  e32 += (d.commissionTax || 0);    // E29
  e32 += discountVal;                // E30

  // F32 = SUM(F11:J31)
  let f32 = 0;
  f32 += (d.shikikin || 0);         // F11
  f32 += (d.reikin || 0);           // F12
  f32 += nextRent;                   // F13
  f32 += nextMgmt;                   // F14
  for (const item of dynamicItems) f32 += item.amount; // F15-F24
  f32 += (d.cleaning || 0);         // F25
  f32 += (d.guarantee || 0);        // F26
  f32 += (d.insurance || 0);        // F27
  f32 += (d.rent || 0);             // F28（一般手数料 = 1ヶ月分家賃）
  f32 += Math.round((d.rent || 0) * 0.1); // F29

  // E35 = E30（スモ割）
  const e35 = discountVal;

  // E37 = 差引請求金額
  // スモラ/ギガ: E32-E34-E36 → E34=E36=0 なので E32
  // イエヤス: E32-E35-E36 → E36=0 なので E32-E35
  const e37 = account === "ieyasu" ? e32 - e35 : e32;

  // E8 = 見積書上部に表示するメイン金額
  // スモラ/ギガ: E37、イエヤス: E32
  const e8 = account === "ieyasu" ? e32 : e37;

  updateCachedValue(ws, "E32", e32);
  updateCachedValue(ws, "F32", f32);
  updateCachedValue(ws, "E35", e35);
  updateCachedValue(ws, "E37", e37);
  updateCachedValue(ws, "E8",  e8);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      account: Account;
      items: ItemData;
    };

    const { account = "sumora", items: d } = body;
    const templateFile = TEMPLATE_FILES[account] || TEMPLATE_FILES.sumora;

    const templatePath = findTemplatePath(templateFile);
    if (!templatePath) {
      const cwd = process.cwd();
      console.error("[fill-estimate] template not found. cwd:", cwd);
      return NextResponse.json(
        { error: `テンプレートが見つかりません（${templateFile}）。cwd=${cwd}` },
        { status: 500 }
      );
    }

    let wb: XLSX.WorkBook;
    try {
      const buf = fs.readFileSync(templatePath);
      wb = XLSX.read(buf, { type: "buffer" });
    } catch (readErr) {
      console.error("[fill-estimate] XLSX read error:", readErr);
      return NextResponse.json(
        { error: `テンプレート読み込みエラー: ${readErr instanceof Error ? readErr.message : String(readErr)}` },
        { status: 500 }
      );
    }

    // 見積書シート（左から2枚目）を使用
    const sheetName = wb.SheetNames.length > 1 ? wb.SheetNames[1] : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      return NextResponse.json(
        { error: `シートが見つかりません（${sheetName}）。テンプレートを確認してください。` },
        { status: 500 }
      );
    }

    fillEstimateSheet(ws, d, account);

    // 見積書シート以外を削除（入力画面・請求書・広告料請求書等）
    for (const name of wb.SheetNames.filter((n) => n !== sheetName)) {
      delete wb.Sheets[name];
    }
    wb.SheetNames = [sheetName];

    let buf: Buffer;
    try {
      buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    } catch (writeErr) {
      console.error("[fill-estimate] XLSX write error:", writeErr);
      return NextResponse.json(
        { error: `Excel書き出しエラー: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}` },
        { status: 500 }
      );
    }

    const accountLabel = ACCOUNT_LABELS[account];
    const customerLabel = d.customerName ? `${d.customerName}様` : "見積書";
    const fileName = `${accountLabel}見積書_${customerLabel}.xlsx`;

    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    });
  } catch (err) {
    console.error("[fill-estimate] unexpected error:", err);
    return NextResponse.json(
      { error: `見積書の作成に失敗しました: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
