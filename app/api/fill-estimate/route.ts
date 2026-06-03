import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import path from "path";
import fs from "fs";

type Account = "sumora" | "ieyasu" | "giga";

const TEMPLATE_FILES: Record<Account, string> = {
  sumora: "sumora-estimate.xlsx",
  ieyasu: "ieyasu-estimate.xlsx",
  giga:   "giga-estimate.xlsx",
};

const ACCOUNT_LABELS: Record<Account, string> = {
  sumora: "スモラ",
  ieyasu: "イエヤス",
  giga:   "ギガ賃貸",
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

// テンプレートアカウント別の節約金額プレースホルダー（drawing2.xml内の固定値）
const SAVINGS_PLACEHOLDER: Record<Account, string> = {
  sumora: "129,720",
  ieyasu: "266,100",
  giga:   "129,720",
};

type JSZipType = import("jszip");

/**
 * ExcelJS出力バッファに元テンプレートのテキスト図形(drawing2.xml)を移植し、
 * 節約金額プレースホルダーを実際の計算値に書き換える。
 *
 * ExcelJSはテキストボックス/ワードアートを保持しないため、
 * 元テンプレートのdrawing2.xmlを直接outputZipに追加する方式を採用。
 */
async function patchSavingsInDrawing(
  exceljsBuf: Buffer,
  templatePath: string,
  account: Account,
  savings: number
): Promise<Buffer> {
  const placeholder = SAVINGS_PLACEHOLDER[account];
  const formatted = savings > 0 ? savings.toLocaleString("ja-JP") : "0";

  const [outputZip, templateZip] = await Promise.all([
    (JSZip as unknown as { loadAsync: (b: Buffer) => Promise<JSZipType> }).loadAsync(exceljsBuf),
    (JSZip as unknown as { loadAsync: (b: Buffer) => Promise<JSZipType> }).loadAsync(fs.readFileSync(templatePath)),
  ]);

  // 元テンプレートのdrawing2.xmlを取得
  const templateDrawing = templateZip.files["xl/drawings/drawing2.xml"];
  if (!templateDrawing) return exceljsBuf;

  let drawingXml = await templateDrawing.async("string");

  // 節約金額プレースホルダーを実際の計算値に置換
  if (drawingXml.includes(">" + placeholder + "<")) {
    drawingXml = drawingXml.split(">" + placeholder + "<").join(">" + formatted + "<");
  }

  // ExcelJS出力には既に画像(drawing1.xml)があるため、
  // drawing2.xml内の画像(xdr:pic)を除去して図形のみに絞る
  drawingXml = drawingXml.replace(/<xdr:twoCellAnchor[^>]*>(?:(?!<xdr:twoCellAnchor).)*?<xdr:pic\b[\s\S]*?<\/xdr:twoCellAnchor>/g, "");

  // outputZipにdrawing2.xmlを追加
  outputZip.file("xl/drawings/drawing2.xml", drawingXml);

  // sheet18.xml.rels に drawing2.xml の参照を追加
  const sheetRelsKey = "xl/worksheets/_rels/sheet18.xml.rels";
  const sheetRelsFile = outputZip.files[sheetRelsKey];
  if (sheetRelsFile) {
    let relsXml = await sheetRelsFile.async("string");
    if (!relsXml.includes("drawing2.xml")) {
      relsXml = relsXml.replace(
        "</Relationships>",
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing2.xml"/></Relationships>`
      );
      outputZip.file(sheetRelsKey, relsXml);
    }
  }

  // [Content_Types].xmlにdrawing2.xmlのエントリを追加
  const ctFile = outputZip.files["[Content_Types].xml"];
  if (ctFile) {
    let ctXml = await ctFile.async("string");
    if (!ctXml.includes("drawing2.xml")) {
      ctXml = ctXml.replace(
        "</Types>",
        `<Override PartName="/xl/drawings/drawing2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`
      );
      outputZip.file("[Content_Types].xml", ctXml);
    }
  }

  return Buffer.from(await outputZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
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

// ExcelJSのセルに値をセット（既存スタイルを保持）
function setCell(ws: ExcelJS.Worksheet, addr: string, value: string | number) {
  const cell = ws.getCell(addr);
  cell.value = value;
}

function fillEstimateSheet(ws: ExcelJS.Worksheet, d: ItemData, account: Account): number {
  // B3（B3:E3マージ）: お客様名を挨拶行に書き込む（入力画面参照数式を上書き）
  ws.getCell("B3").value = d.customerName ? `${d.customerName} 様` : "";
  // M9（住所欄）: 入力画面参照数式を削除後に#REF!にならないようクリア
  ws.getCell("M9").value = "";
  // 動的行（15〜24）のみクリア（B=ラベル, E/F=金額）
  // ※ 行25以降は固定ラベル（抗菌施工費・賃貸保証料等）があるのでB列は触らない
  for (let r = 15; r <= 24; r++) {
    ws.getCell(`B${r}`).value = null;
    ws.getCell(`E${r}`).value = null;
    ws.getCell(`F${r}`).value = null;
  }

  // ── 物件情報（右上）
  setCell(ws, "M8",  d.propertyName || "");
  setCell(ws, "N9",  d.roomNumber   || "");
  setCell(ws, "M10", d.customerName || "");

  // ── 契約条件（右側列 L〜N）
  setCell(ws, "M12", d.hoshokikin    || 0);
  setCell(ws, "M13", d.shikikin      || 0);
  setCell(ws, "M14", d.reikin        || 0);
  setCell(ws, "M15", d.rent          || 0);
  setCell(ws, "M16", d.managementFee || 0);
  setCell(ws, "M19", d.parkingDeposit || 0);

  // ── 固定上段費用
  setCell(ws, "E11", d.shikikin || 0);
  setCell(ws, "F11", d.shikikin || 0);
  setCell(ws, "E12", d.reikin   || 0);
  setCell(ws, "F12", d.reikin   || 0);
  const nextRent = d.nextRent        || d.rent          || 0;
  const nextMgmt = d.nextManagementFee || d.managementFee || 0;
  setCell(ws, "E13", nextRent);
  setCell(ws, "F13", nextRent);
  setCell(ws, "E14", nextMgmt);
  setCell(ws, "F14", nextMgmt);

  // ── 日割り計算
  const moveInDay   = d.moveInDay        || 1;
  const monthDays   = d.moveInMonthDays  || 30;
  const proratedDays = monthDays - moveInDay + 1;
  const prorated = (amount: number) =>
    amount ? Math.round((amount / monthDays) * proratedDays) : 0;
  const proratedRent  = prorated(d.rent);
  const proratedMgmt  = prorated(d.managementFee);
  const proratedWater = prorated(d.waterFee);

  // ── 動的項目（行15〜24）
  type DynItem = { label: string; amount: number };
  const dynamicItems: DynItem[] = [];

  // moveInDay=1（月初入居）は日割りなし（翌月家賃と二重払いになるため）
  if (proratedRent > 0 && moveInDay > 1)
    dynamicItems.push({ label: `日割り家賃（${proratedDays}日分）`, amount: proratedRent });
  if (proratedMgmt > 0 && moveInDay > 1)
    dynamicItems.push({ label: `日割り共益費（${proratedDays}日分）`, amount: proratedMgmt });
  if (proratedWater > 0 && moveInDay > 1)
    dynamicItems.push({ label: `日割り水道代（${proratedDays}日分）`, amount: proratedWater });
  if (d.keyExchange)
    dynamicItems.push({ label: "鍵交換代", amount: d.keyExchange });
  const parkingTotal = (d.parkingCommission || 0) + (d.parkingCommissionTax || 0);
  if (parkingTotal > 0)
    dynamicItems.push({ label: "駐車場仲介手数料", amount: parkingTotal });
  if (d.parkingMonthly)
    dynamicItems.push({ label: "翌月駐車場代", amount: d.parkingMonthly });
  if (d.nextWaterFee)
    dynamicItems.push({ label: "翌月水道代", amount: d.nextWaterFee });
  for (const oi of d.otherItems || []) {
    if (oi.item && oi.amount > 0)
      dynamicItems.push({ label: oi.item, amount: oi.amount });
  }

  for (let i = 0; i < Math.min(dynamicItems.length, 10); i++) {
    const row = 15 + i;
    setCell(ws, `B${row}`, dynamicItems[i].label);
    setCell(ws, `E${row}`, dynamicItems[i].amount);
    setCell(ws, `F${row}`, dynamicItems[i].amount);
  }

  // ── 固定下段費用
  setCell(ws, "E25", d.cleaning  || 0);
  setCell(ws, "F25", d.cleaning  || 0);
  setCell(ws, "E26", d.guarantee || 0);
  setCell(ws, "F26", d.guarantee || 0);
  setCell(ws, "E27", d.insurance || 0);
  setCell(ws, "F27", d.insurance || 0);

  // 仲介手数料
  setCell(ws, "E28", d.commission    || 0);
  setCell(ws, "F28", d.rent          || 0);
  setCell(ws, "E29", d.commissionTax || 0);
  setCell(ws, "F29", Math.round((d.rent || 0) * 0.1));

  // スモ割
  const discountVal = d.discountAmount ? -(d.discountAmount) : 0;
  setCell(ws, "E30", discountVal);

  // ── 合計・差引金額を静的値でセット
  let e32 = 0;
  e32 += (d.shikikin || 0);
  e32 += (d.reikin   || 0);
  e32 += nextRent;
  e32 += nextMgmt;
  for (const item of dynamicItems) e32 += item.amount;
  e32 += (d.cleaning  || 0);
  e32 += (d.guarantee || 0);
  e32 += (d.insurance || 0);
  e32 += (d.commission    || 0);
  e32 += (d.commissionTax || 0);
  e32 += discountVal;
  // nextWaterFeeはdynamicItemsに含まれているのでfor loopで加算済み

  let f32 = 0;
  f32 += (d.shikikin || 0);
  f32 += (d.reikin   || 0);
  f32 += nextRent;
  f32 += nextMgmt;
  for (const item of dynamicItems) f32 += item.amount;
  f32 += (d.cleaning  || 0);
  f32 += (d.guarantee || 0);
  f32 += (d.insurance || 0);
  f32 += (d.rent      || 0);
  f32 += Math.round((d.rent || 0) * 0.1);

  // discountValはe32に既に含まれているので全アカウント共通でe37=e32
  const e35 = discountVal;
  const e37 = e32;
  const e8  = e32;

  setCell(ws, "E32", e32);
  setCell(ws, "F32", f32);
  setCell(ws, "E35", e35);
  setCell(ws, "E37", e37);
  setCell(ws, "E8",  e8);
  // M1 = 作成日（テンプレートは NOW() だが静的な今日の日付で上書き）
  const t = new Date();
  setCell(ws, "M1", `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`);

  // 節約金額（一般との差額）を返す
  return Math.max(0, f32 - e32);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { account: Account; items: ItemData };
    const { account = "sumora", items: d } = body;
    const templateFile = TEMPLATE_FILES[account] || TEMPLATE_FILES.sumora;

    const templatePath = findTemplatePath(templateFile);
    if (!templatePath) {
      console.error("[fill-estimate] template not found. cwd:", process.cwd());
      return NextResponse.json(
        { error: `テンプレートが見つかりません（${templateFile}）` },
        { status: 500 }
      );
    }

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(templatePath);
    } catch (readErr) {
      console.error("[fill-estimate] read error:", readErr);
      return NextResponse.json(
        { error: `テンプレート読み込みエラー: ${readErr instanceof Error ? readErr.message : String(readErr)}` },
        { status: 500 }
      );
    }

    // 見積書シート（左から2枚目）
    const targetSheet = wb.worksheets.length > 1 ? wb.worksheets[1] : wb.worksheets[0];
    if (!targetSheet) {
      return NextResponse.json({ error: "見積書シートが見つかりません" }, { status: 500 });
    }

    const savings = fillEstimateSheet(targetSheet, d, account);

    // 見積書シート以外を削除
    const keepId = targetSheet.id;
    for (const ws of [...wb.worksheets]) {
      if (ws.id !== keepId) wb.removeWorksheet(ws.id);
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(await wb.xlsx.writeBuffer());
      // 元テンプレートのテキスト図形を移植し節約金額を動的書き換え
      buf = await patchSavingsInDrawing(buf, templatePath, account, savings);
    } catch (writeErr) {
      console.error("[fill-estimate] write error:", writeErr);
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
