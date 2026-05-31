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

function setCellValue(ws: XLSX.WorkSheet, cellAddr: string, value: string | number) {
  const type = typeof value === "number" ? "n" : "s";
  ws[cellAddr] = { v: value, t: type };

  // worksheet の !ref を拡張して書き込んだセルを確実に含める
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

function calcProratedAmount(amount: number, moveInDay: number, monthDays: number): number {
  if (!amount || !moveInDay || !monthDays) return 0;
  const days = monthDays - moveInDay + 1;
  return Math.round((amount / monthDays) * days);
}

// テンプレートファイルパスを複数候補から探す（Vercel対応）
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      account: Account;
      items: {
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
    };

    const { account = "sumora", items: d } = body;
    const templateFile = TEMPLATE_FILES[account] || TEMPLATE_FILES.sumora;

    const templatePath = findTemplatePath(templateFile);
    if (!templatePath) {
      const cwd = process.cwd();
      const tried = [
        path.join(cwd, "public", "templates", templateFile),
        path.join("/var/task", "public", "templates", templateFile),
      ];
      console.error("[fill-estimate] template not found. cwd:", cwd, "tried:", tried);
      return NextResponse.json(
        { error: `テンプレートが見つかりません（${templateFile}）。cwd=${cwd}` },
        { status: 500 }
      );
    }

    // テンプレート読み込み
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

    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];

    // ─── 右側セクション（物件情報） ───
    setCellValue(ws, "B2", d.assignee || "");
    setCellValue(ws, "H2", d.propertyName || "");
    setCellValue(ws, "B4", d.customerName || "");
    setCellValue(ws, "E4", d.moveInMonthDays || 31);
    setCellValue(ws, "I5", d.roomNumber || "");
    setCellValue(ws, "H5", d.shikikin || 0);
    setCellValue(ws, "H6", d.reikin || 0);
    setCellValue(ws, "H7", d.rent || 0);
    setCellValue(ws, "H8", d.managementFee || 0);

    // ─── 日割り計算 ───
    const moveInDay = d.moveInDay || 1;
    const monthDays = d.moveInMonthDays || 30;
    const proratedRent = calcProratedAmount(d.rent, moveInDay, monthDays);
    const proratedMgmt = calcProratedAmount(d.managementFee, moveInDay, monthDays);
    const proratedWater = calcProratedAmount(d.waterFee, moveInDay, monthDays);
    const proratedDays = monthDays - moveInDay + 1;

    // 左側セクション（費用計算）
    setCellValue(ws, "C9", d.moveInMonth || "");
    setCellValue(ws, "D9", moveInDay);
    setCellValue(ws, "E9", proratedDays);

    // 右側の数値（日割計算用）
    setCellValue(ws, "H16", proratedRent);
    setCellValue(ws, "H17", proratedMgmt);
    setCellValue(ws, "H18", proratedWater);
    setCellValue(ws, "H20", 0); // 日割駐車場

    // 翌月分
    setCellValue(ws, "B14", d.nextRent || d.rent || 0);
    setCellValue(ws, "B15", d.nextManagementFee || d.managementFee || 0);

    // 仲介手数料
    setCellValue(ws, "B21", d.commission || 0);
    setCellValue(ws, "B22", d.commissionTax || 0);
    setCellValue(ws, "B23", d.parkingCommission || 0);
    setCellValue(ws, "B24", d.parkingCommissionTax || 0);

    // 保険・鍵・クリーニング・保証料
    setCellValue(ws, "B25", d.insurance || 0);
    setCellValue(ws, "B26", d.cleaning || 0);
    setCellValue(ws, "B27", d.keyExchange || 0);
    setCellValue(ws, "B28", d.guarantee || 0);

    // 入居日
    if (d.moveInDate) {
      const dateObj = new Date(d.moveInDate);
      const dateStr = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;
      setCellValue(ws, "H28", dateStr);
    }

    // 保証金・敷金（左側）
    setCellValue(ws, "B6", d.hoshokikin || 0);
    setCellValue(ws, "B7", d.shikikin || 0);

    // 保証金（右側）
    setCellValue(ws, "H4", d.hoshokikin || 0);

    // 駐車場保証金
    setCellValue(ws, "B18", d.parkingDeposit || 0);
    setCellValue(ws, "B19", d.parkingMonthly || 0);

    // 特別割引
    if (d.discountAmount) {
      setCellValue(ws, "B30", -(d.discountAmount));
      if (d.discountNote) setCellValue(ws, "A30", `特別割引: ${d.discountNote}`);
    }

    // Excel 書き出し
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
