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
}

function calcProratedAmount(amount: number, moveInDay: number, monthDays: number): number {
  if (!amount || !moveInDay || !monthDays) return 0;
  const days = monthDays - moveInDay + 1;
  return Math.round((amount / monthDays) * days);
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
    const templatePath = path.join(process.cwd(), "public", "templates", templateFile);

    if (!fs.existsSync(templatePath)) {
      console.error("[fill-estimate] template not found:", templatePath, "cwd:", process.cwd());
      return NextResponse.json({ error: `テンプレートファイルが見つかりません: ${templateFile}` }, { status: 500 });
    }

    const wb = XLSX.readFile(templatePath);
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

    // 保証金・敷金（右側）
    setCellValue(ws, "H4", d.hoshokikin || 0);

    // 駐車場保証金
    setCellValue(ws, "B18", d.parkingDeposit || 0);
    setCellValue(ws, "B19", d.parkingMonthly || 0);

    const accountLabel = ACCOUNT_LABELS[account];
    const customerLabel = d.customerName ? `${d.customerName}様` : "見積書";
    const fileName = `${accountLabel}見積書_${customerLabel}.xlsx`;

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    });
  } catch (err) {
    console.error("[fill-estimate]", err);
    return NextResponse.json({ error: "見積書の作成に失敗しました" }, { status: 500 });
  }
}
