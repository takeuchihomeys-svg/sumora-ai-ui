"use client";

import { useRef, useState } from "react";
import html2canvas from "html2canvas";
import BottomNav from "../components/BottomNav";
import type { ExtractedEstimate } from "../api/extract-estimate-info/route";

type Account = "sumora" | "ieyasu" | "giga";
type Step = "input" | "review";

const ACCOUNT_CONFIG: Record<Account, { label: string; grad: string; accent: string }> = {
  sumora: { label: "スモラ",    grad: "linear-gradient(135deg,#1565C0,#2196F3,#4BA8E8)", accent: "#1565C0" },
  ieyasu: { label: "イエヤス",  grad: "linear-gradient(135deg,#bf360c,#e65100,#ff6d00)", accent: "#e65100" },
  giga:   { label: "ギガ賃貸", grad: "linear-gradient(135deg,#1b5e20,#2e7d32,#43a047)", accent: "#1b5e20" },
};

// アカウント別仲介手数料デフォルト
const ACCOUNT_COMMISSION: Record<Account, { commission: number; commissionTax: number }> = {
  sumora: { commission: 2980, commissionTax: 298 },
  ieyasu: { commission: 0,    commissionTax: 0 },
  giga:   { commission: 0,    commissionTax: 0 },
};

type EditableItems = Omit<ExtractedEstimate, "otherItems"> & {
  otherItems: Array<{ item: string; amount: number }>;
  nextRent: number;
  nextManagementFee: number;
  nextWaterFee: number;
  nextMonth: number;
  nextYear: number;
  guaranteeRate: number; // 賃貸保証料率（%）デフォルト50
};

// 翌月1日の日付文字列を返す（デフォルト入居日）
function getDefaultMoveInDate(): string {
  const now = new Date();
  const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const m = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function calcNext(moveInDate: string) {
  if (!moveInDate) return { nextMonth: 0, nextYear: 0 };
  const d = new Date(moveInDate);
  const m = d.getMonth(); // 0-indexed
  return {
    nextMonth: m === 11 ? 1 : m + 2,
    nextYear: m === 11 ? d.getFullYear() + 1 : d.getFullYear(),
  };
}

// 入居日文字列からmoveInDay・moveInMonth・moveInMonthDaysを計算
// 日付未選択 or 1日入居 → moveInDay=1（日割りなし）
function calcMoveInInfo(moveInDate: string) {
  if (!moveInDate) return { moveInDay: 1, moveInMonth: 0, moveInMonthDays: 30 };
  const d = new Date(moveInDate);
  const year  = d.getFullYear();
  const month = d.getMonth() + 1; // 1-indexed
  const day   = d.getDate();
  const monthDays = new Date(year, month, 0).getDate(); // その月の日数
  return { moveInDay: day, moveInMonth: month, moveInMonthDays: monthDays };
}

// 保証料計算の基準額 = 家賃 + 共益費 + 水道代
function calcGuaranteeBase(rent: number, managementFee: number, waterFee: number) {
  return (rent || 0) + (managementFee || 0) + (waterFee || 0);
}

function calcProratedDays(moveInDay: number, monthDays: number) {
  // 月初（1日）入居は日割りなし（Excelと同じ挙動）
  if (!moveInDay || moveInDay <= 1) return 0;
  return monthDays - moveInDay + 1;
}

function fmtYen(n: number) {
  return `¥${Number(n || 0).toLocaleString()}`;
}

const ITEM_CONFIG: Array<{
  key: keyof EditableItems;
  label: string;
  group?: string;
  derived?: boolean;
}> = [
  { key: "propertyName",    label: "物件名",          group: "基本情報" },
  { key: "roomNumber",      label: "号室",            group: "基本情報" },
  { key: "customerName",    label: "入居者名",        group: "基本情報" },
  { key: "assignee",        label: "担当者名",        group: "基本情報" },
  // moveInDate・moveInMonthDays はStep2の専用UIで操作（フォームには出さない）
  { key: "rent",            label: "月額家賃",          group: "賃料" },
  { key: "managementFee",   label: "共益費・管理費" },
  { key: "waterFee",        label: "水道代（月額）" },
  { key: "shikikin",        label: "敷金",              group: "初期費用" },
  { key: "reikin",          label: "礼金" },
  { key: "hoshokikin",      label: "保証金" },
  { key: "commission",      label: "仲介手数料（税抜）" },
  { key: "commissionTax",   label: "仲介手数料 消費税" },
  { key: "parkingCommission",    label: "駐車場手数料（税抜）" },
  { key: "parkingCommissionTax", label: "駐車場手数料 消費税" },
  { key: "guaranteeRate",   label: "保証料率（%）" },
  { key: "guarantee",       label: "賃貸保証料（自動計算）" },
  { key: "insurance",       label: "住宅保険" },
  { key: "keyExchange",     label: "鍵交換代" },
  { key: "cleaning",        label: "クリーニング代" },
  { key: "parkingDeposit",  label: "駐車場保証金",      group: "駐車場" },
  { key: "parkingMonthly",  label: "翌月駐車場代" },
  { key: "discountAmount",  label: "割引額",            group: "割引" },
  { key: "discountNote",    label: "割引メモ" },
  { key: "nextRent",        label: "翌月家賃（変更あれば）", group: "翌月分" },
  { key: "nextManagementFee", label: "翌月共益費（変更あれば）" },
  { key: "nextWaterFee",    label: "翌月水道代（変更あれば）" },
];

const TEXT_KEYS = new Set(["propertyName", "roomNumber", "customerName", "assignee", "moveInDate", "discountNote", "supplementaryNotes"]);
const PERCENT_KEYS = new Set(["guaranteeRate"]);
const GROUP_ORDER = ["基本情報", "入居情報", "賃料", "初期費用", "駐車場", "割引", "翌月分"];

type PreviewRow = {
  label: string;
  amount: number;
  editKey?: keyof EditableItems;
  otherIdx?: number;
  isDiscount?: boolean;
  isComputed?: boolean;
  alwaysShow?: boolean;
};

const ACCOUNT_SAVINGS_TEMPLATE: Record<Account, (n: number) => string> = {
  sumora:  (n) => `スモラなら一般的な不動産業者より${n.toLocaleString()}円節約出来ます！！`,
  ieyasu:  (n) => `イエヤスなら一般的な不動産業者より${n.toLocaleString()}円節約出来ます！！`,
  giga:    (n) => `ギガ賃貸なら一般的な不動産業者より${n.toLocaleString()}円節約出来ます！！`,
};

function generateLineText(
  items: EditableItems,
  grandTotal: number,
  account: Account,
): string {
  const parts: string[] = [];

  // 【物件名 号室】
  const propName = items.propertyName || "";
  const roomSuffix = items.roomNumber ? ` ${items.roomNumber}号室` : "";
  if (propName || roomSuffix) {
    parts.push(`【${propName}${roomSuffix}】`);
    parts.push("");
  }

  // 割引あり → 強調フォーマット
  const discount = items.discountAmount || 0;
  if (discount > 0) {
    parts.push("初期費用さらに");
    parts.push(`🌟${discount.toLocaleString()}円割引させて頂き`);
    parts.push(`初期費用：${grandTotal.toLocaleString()}円`);
  } else {
    parts.push(`初期費用：${grandTotal.toLocaleString()}円`);
  }

  parts.push("");

  // 節約額 = (業界標準手数料1ヶ月+税 - 実際の手数料) + 割引額
  const standardCommission = Math.round((items.rent || 0) * 1.1);
  const actualCommission = (items.commission || 0) + (items.commissionTax || 0);
  const savings = Math.max(0, standardCommission - actualCommission + discount);
  if (savings > 0) {
    parts.push(ACCOUNT_SAVINGS_TEMPLATE[account](savings));
    parts.push("");
  }

  // 日付未設定のときのみ注記を追加（設定済みなら日割りは既に計算済みなので不要）
  if (!items.moveInDate) {
    parts.push("※ご入居日によって日割家賃が発生致します。");
  }

  return parts.join("\n");
}

function toEditable(e: ExtractedEstimate, account: Account = "sumora", moveInDate = ""): EditableItems {
  const { nextMonth, nextYear } = calcNext(moveInDate);
  const { moveInDay, moveInMonth, moveInMonthDays } = calcMoveInInfo(moveInDate);
  const commDefaults = ACCOUNT_COMMISSION[account];
  const guaranteeRate = 50;
  return {
    ...e,
    moveInDate,
    moveInDay,
    moveInMonth,
    moveInMonthDays,
    // アカウントの手数料が0固定（イエヤス・ギガ）は常に0 / スモラはAIが0のときのみデフォルト2980
    commission:    commDefaults.commission    === 0 ? 0 : (e.commission    || commDefaults.commission),
    commissionTax: commDefaults.commissionTax === 0 ? 0 : (e.commissionTax || commDefaults.commissionTax),
    guaranteeRate,
    // 常に（家賃+共益費+水道代）×率%で計算（OCR抽出値は無視）
    guarantee: Math.round(calcGuaranteeBase(e.rent, e.managementFee, e.waterFee) * guaranteeRate / 100),
    nextRent: e.rent,
    nextManagementFee: e.managementFee,
    nextWaterFee: e.waterFee,
    nextMonth,
    nextYear,
  };
}

// アカウントのデフォルト値で空の EditableItems を生成（手動入力用）
function makeBlankItems(account: Account, moveInDate = ""): EditableItems {
  const { nextMonth, nextYear } = calcNext(moveInDate);
  const { moveInDay, moveInMonth, moveInMonthDays } = calcMoveInInfo(moveInDate);
  const commDefaults = ACCOUNT_COMMISSION[account];
  return {
    propertyName: "", roomNumber: "", customerName: "", assignee: "",
    moveInDate, moveInMonth, moveInDay, moveInMonthDays,
    rent: 0, managementFee: 0, waterFee: 0,
    shikikin: 0, reikin: 0, hoshokikin: 0,
    commission: commDefaults.commission,
    commissionTax: commDefaults.commissionTax,
    parkingCommission: 0, parkingCommissionTax: 0,
    guaranteeRate: 50,
    guarantee: 0, insurance: 0, keyExchange: 0, cleaning: 0,
    parkingDeposit: 0, parkingMonthly: 0,
    otherItems: [],
    discountAmount: 0, discountNote: "", supplementaryNotes: "",
    nextRent: 0, nextManagementFee: 0, nextWaterFee: 0,
    nextMonth, nextYear,
  };
}

export default function EstimatePage() {
  const [account, setAccount] = useState<Account>("sumora");
  const [step, setStep] = useState<Step>("input");
  const cfg = ACCOUNT_CONFIG[account];

  // Step 1 inputs
  const [images, setImages] = useState<Array<{ base64: string; mimeType: string; name: string }>>([]);
  const [supplementaryText, setSupplementaryText] = useState("");
  const [step1MoveInDate, setStep1MoveInDate] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2: editable extracted data
  const [items, setItems] = useState<EditableItems | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  const reviewRef = useRef<HTMLDivElement>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const [capturing, setCapturing] = useState(false);
  const [lineModal, setLineModal] = useState(false);
  const [lineText, setLineText] = useState("");
  const [lineCopied, setLineCopied] = useState(false);

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = (e.target?.result as string).split(",")[1];
        setImages((prev) => [
          ...prev,
          { base64, mimeType: file.type, name: file.name },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((i) => i.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    imageItems.forEach((item) => {
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = (ev.target?.result as string).split(",")[1];
        setImages((prev) => [
          ...prev,
          { base64, mimeType: file.type, name: `貼付け画像${prev.length + 1}` },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (idx: number) => setImages((p) => p.filter((_, i) => i !== idx));

  const handleExtract = async () => {
    if (images.length === 0 && !supplementaryText.trim()) {
      setExtractError("画像をアップロードするか補足情報を入力してください");
      return;
    }
    setExtractError("");
    setExtracting(true);
    try {
      const res = await fetch("/api/extract-estimate-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: images.map(({ base64, mimeType }) => ({ base64, mimeType })),
          supplementaryText,
        }),
      });
      const data = await res.json() as { ok: boolean; extracted?: ExtractedEstimate; error?: string };
      if (!data.ok || !data.extracted) {
        setExtractError(data.error || "読み取りに失敗しました");
        return;
      }
      setItems(toEditable(data.extracted, account, step1MoveInDate));
      setStep("review");
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch {
      setExtractError("ネットワークエラーが発生しました");
    } finally {
      setExtracting(false);
    }
  };

  const updateItem = (key: keyof EditableItems, value: string | number) => {
    setItems((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, [key]: value } as EditableItems;
      // moveInDate変更時: 翌月 + moveInDay/moveInMonth/moveInMonthDays を全て再計算
      if (key === "moveInDate") {
        const { nextMonth, nextYear } = calcNext(value as string);
        const { moveInDay, moveInMonth, moveInMonthDays } = calcMoveInInfo(value as string);
        updated.nextMonth = nextMonth;
        updated.nextYear = nextYear;
        updated.moveInDay = moveInDay;
        updated.moveInMonth = moveInMonth;
        updated.moveInMonthDays = moveInMonthDays;
      }
      // 家賃・共益費・水道代変更時に翌月分も連動（手動入力で翌月分が0のまま防止）
      if (key === "rent") {
        updated.nextRent = Number(value) || 0;
        // 家賃変更時に保証料も再計算（基準: 家賃+共益費+水道代）
        updated.guarantee = Math.round(calcGuaranteeBase(Number(value), prev.managementFee, prev.waterFee) * (prev.guaranteeRate || 0) / 100);
      }
      if (key === "managementFee") {
        updated.nextManagementFee = Number(value) || 0;
        // 共益費変更時も保証料を再計算
        updated.guarantee = Math.round(calcGuaranteeBase(prev.rent, Number(value), prev.waterFee) * (prev.guaranteeRate || 0) / 100);
      }
      if (key === "waterFee") {
        updated.nextWaterFee = Number(value) || 0;
        // 水道代変更時も保証料を再計算
        updated.guarantee = Math.round(calcGuaranteeBase(prev.rent, prev.managementFee, Number(value)) * (prev.guaranteeRate || 0) / 100);
      }
      // 保証料率変更時に保証料を自動計算（家賃+共益費+水道代）×率%
      if (key === "guaranteeRate") {
        updated.guarantee = Math.round(calcGuaranteeBase(prev.rent, prev.managementFee, prev.waterFee) * (Number(value) || 0) / 100);
      }
      // 仲介手数料変更時に消費税を自動計算（10%）
      if (key === "commission") {
        updated.commissionTax = Math.round((Number(value) || 0) * 0.1);
      }
      // 駐車場手数料変更時も同様
      if (key === "parkingCommission") {
        updated.parkingCommissionTax = Math.round((Number(value) || 0) * 0.1);
      }
      return updated;
    });
  };

  const addOtherItem = () => {
    setItems((prev) => prev ? { ...prev, otherItems: [...prev.otherItems, { item: "", amount: 0 }] } : prev);
  };

  const updateOtherItem = (idx: number, field: "item" | "amount", val: string) => {
    setItems((prev) => {
      if (!prev) return prev;
      const updated = [...prev.otherItems];
      updated[idx] = { ...updated[idx], [field]: field === "amount" ? Number(val) || 0 : val };
      return { ...prev, otherItems: updated };
    });
  };

  const removeOtherItem = (idx: number) => {
    setItems((prev) => prev ? { ...prev, otherItems: prev.otherItems.filter((_, i) => i !== idx) } : prev);
  };

  const handleDownload = async () => {
    if (!items) return;
    setDownloadError("");
    setDownloading(true);
    try {
      const res = await fetch("/api/fill-estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, items }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setDownloadError(err.error || "ダウンロードに失敗しました");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const label = ACCOUNT_CONFIG[account].label;
      const name = items.customerName ? `${items.customerName}様` : "見積書";
      a.href = url;
      a.download = `${label}見積書_${name}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("ダウンロードに失敗しました");
    } finally {
      setDownloading(false);
    }
  };

  // プレビュー計算
  const proratedDays = items ? calcProratedDays(items.moveInDay || 1, items.moveInMonthDays || 30) : 0;
  const proratedRent = items ? Math.round(((items.rent || 0) / (items.moveInMonthDays || 30)) * proratedDays) : 0;
  const proratedMgmt = items ? Math.round(((items.managementFee || 0) / (items.moveInMonthDays || 30)) * proratedDays) : 0;
  const proratedWater = items ? Math.round(((items.waterFee || 0) / (items.moveInMonthDays || 30)) * proratedDays) : 0;

  const costRows: PreviewRow[] = items ? ([
    { label: "保証金",                              amount: items.hoshokikin,          editKey: "hoshokikin" },
    { label: "敷金",                               amount: items.shikikin,             editKey: "shikikin" },
    { label: "礼金",                               amount: items.reikin,               editKey: "reikin" },
    { label: items.moveInMonth > 0 ? `${items.moveInMonth}月分 日割家賃`  : "日割家賃",  amount: proratedRent,  isComputed: true },
    { label: items.moveInMonth > 0 ? `${items.moveInMonth}月分 日割共益費` : "日割共益費", amount: proratedMgmt,  isComputed: true },
    { label: items.moveInMonth > 0 ? `${items.moveInMonth}月分 日割水道代` : "日割水道代", amount: proratedWater, isComputed: true },
    { label: items.nextMonth > 0 ? `${items.nextMonth}月分 家賃`   : "翌月家賃",   amount: items.nextRent,            editKey: "nextRent" },
    { label: items.nextMonth > 0 ? `${items.nextMonth}月分 共益費` : "翌月共益費", amount: items.nextManagementFee,   editKey: "nextManagementFee" },
    { label: items.nextMonth > 0 ? `${items.nextMonth}月分 水道代` : "翌月水道代", amount: items.nextWaterFee,        editKey: "nextWaterFee" },
    { label: "仲介手数料",                          amount: items.commission,           editKey: "commission",    alwaysShow: true },
    { label: "仲介手数料 消費税",                   amount: items.commissionTax,        editKey: "commissionTax", alwaysShow: true },
    { label: "駐車場手数料",                        amount: items.parkingCommission,    editKey: "parkingCommission" },
    { label: "駐車場手数料 消費税",                 amount: items.parkingCommissionTax, editKey: "parkingCommissionTax" },
    { label: "賃貸保証料",                          amount: items.guarantee,            editKey: "guarantee", alwaysShow: true },
    { label: "住宅保険",                            amount: items.insurance,            editKey: "insurance" },
    { label: "鍵交換代",                            amount: items.keyExchange,          editKey: "keyExchange" },
    { label: "クリーニング代",                       amount: items.cleaning,             editKey: "cleaning" },
    { label: "駐車場保証金",                        amount: items.parkingDeposit,       editKey: "parkingDeposit" },
    { label: items.nextMonth > 0 ? `${items.nextMonth}月分 駐車場代` : "翌月駐車場代", amount: items.parkingMonthly, editKey: "parkingMonthly" },
    ...items.otherItems.map((o, i): PreviewRow => ({ label: o.item, amount: o.amount, otherIdx: i })),
  ] as PreviewRow[]).filter((r) => r.amount !== 0 || r.alwaysShow || r.otherIdx !== undefined) : [];

  // 特別割引は 0 でも常に表示
  const discountRow: PreviewRow = {
    label: "特別割引",
    amount: -(items?.discountAmount || 0),
    editKey: "discountAmount",
    isDiscount: true,
  };
  const totalItems: PreviewRow[] = items ? [...costRows, discountRow] : [];

  const grandTotal = totalItems.reduce((s, r) => s + r.amount, 0);

  const handleCaptureAndShare = async () => {
    if (!printRef.current || !items) return;
    setCapturing(true);
    try {
      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
      });

      // base64に変換
      const imageBase64 = canvas.toDataURL("image/png");

      // 自分のLINEに送る
      const res = await fetch("/api/send-estimate-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64 }),
      });

      if (!res.ok) {
        // フォールバック: ダウンロード
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((b) => resolve(b!), "image/png")
        );
        const name = items.customerName ? `${items.customerName}様_見積書.png` : "見積書.png";
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // no-op
    } finally {
      setCapturing(false);
    }
  };

  const handleRefresh = () => {
    setItems(null);
    setImages([]);
    setStep("input");
    setExtractError("");
    setDownloadError("");
    setSupplementaryText("");
    setStep1MoveInDate("");
    setLineModal(false);
    const doReload = () => window.location.reload();
    if (typeof window !== "undefined" && "caches" in window) {
      caches.keys().then((names) =>
        Promise.all(names.map((n) => caches.delete(n))).then(doReload)
      );
    } else {
      doReload();
    }
  };

  const handleLinePreview = () => {
    if (!items) return;
    const text = generateLineText(items, grandTotal, account);
    setLineText(text);
    setLineModal(true);
    setLineCopied(false);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(lineText);
      setLineCopied(true);
      setTimeout(() => setLineCopied(false), 2500);
    } catch {
      // clipboard API unavailable
    }
  };

  // グループ別に ITEM_CONFIG を整理
  const groups: Record<string, typeof ITEM_CONFIG> = {};
  ITEM_CONFIG.forEach((cfg) => {
    const g = cfg.group || "__no_group";
    if (!groups[g]) groups[g] = [];
    groups[g].push(cfg);
  });

  return (
    <main
      className="flex h-[calc(100svh-56px)] flex-col overflow-hidden"
      style={{ background: "linear-gradient(180deg,#f0f7ff 0%,#eef6ff 60%,#f5faff 100%)" }}
    >
      {/* ヘッダー */}
      <header
        className="shrink-0 px-4 pb-3 pt-[max(10px,env(safe-area-inset-top))]"
        style={{ background: cfg.grad }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[17px] font-bold text-white">見積書作成</div>
          {step === "review" && (
            <button
              onClick={() => setStep("input")}
              className="rounded-full bg-white/20 px-3 py-1 text-[11px] font-bold text-white"
            >
              ← 戻る
            </button>
          )}
        </div>

        {/* アカウント選択 */}
        <div className="flex gap-2">
          {(["sumora", "ieyasu", "giga"] as Account[]).map((a) => (
            <button
              key={a}
              onClick={() => {
                setAccount(a);
                setItems(null);
                setStep("input");
              }}
              className="flex-1 rounded-full py-1.5 text-[13px] font-bold transition"
              style={
                account === a
                  ? { backgroundColor: "white", color: cfg.accent }
                  : { backgroundColor: "rgba(255,255,255,0.2)", color: "white" }
              }
            >
              {ACCOUNT_CONFIG[a].label}
            </button>
          ))}
        </div>

        {/* ステップインジケーター */}
        <div className="mt-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {[
              { num: "1", label: "資料・情報入力" },
              { num: "2", label: "確認・調整・作成" },
            ].map((s, idx) => (
              <div key={idx} className="flex items-center gap-1">
                {idx > 0 && <div className="h-px w-6 bg-white/40" />}
                <div className="flex items-center gap-1">
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
                    style={
                      (idx === 0 && step === "input") || (idx === 1 && step === "review")
                        ? { backgroundColor: "white", color: cfg.accent }
                        : { backgroundColor: "rgba(255,255,255,0.3)", color: "white" }
                    }
                  >
                    {s.num}
                  </span>
                  <span className="text-[10px] text-white/90">{s.label}</span>
                </div>
              </div>
            ))}
          </div>
          {/* 更新ボタン */}
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] text-white/90 active:bg-white/30"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            更新
          </button>
        </div>
      </header>

      {/* スクロール領域 */}
      <div className="flex-1 overflow-y-auto">

        {/* ─── STEP 1: 資料入力 ─── */}
        {step === "input" && (
          <div className="p-4 flex flex-col gap-4">

            {/* 画像アップロードエリア */}
            <section>
              <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accent }}>
                資料画像（物件資料・料金表・請求書など）
              </div>
              <div
                className="rounded-2xl border-2 border-dashed border-[#b3d4f5] bg-white p-4 text-center"
                onPaste={handlePaste}
                tabIndex={0}
              >
                <div className="text-[13px] text-[#667781] mb-3">
                  画像をここに貼り付け（Ctrl+V）<br />
                  またはファイルを選択
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-full px-5 py-2 text-[13px] font-bold text-white"
                  style={{ background: cfg.grad }}
                >
                  ＋ 画像を選択
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFileSelect(e.target.files)}
                />
              </div>

              {/* アップロード済み画像プレビュー */}
              {images.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {images.map((img, idx) => (
                    <div key={idx} className="relative rounded-xl overflow-hidden bg-white border border-[#e9edef]">
                      {img.mimeType.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`data:${img.mimeType};base64,${img.base64}`}
                          alt={img.name}
                          className="h-20 w-20 object-cover"
                        />
                      ) : (
                        <div className="flex h-20 w-20 items-center justify-center bg-[#f0f2f5] text-[10px] text-[#667781] font-bold">
                          PDF
                        </div>
                      )}
                      <button
                        onClick={() => removeImage(idx)}
                        className="absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white text-[11px] leading-none"
                      >
                        ×
                      </button>
                      <div className="truncate px-1 pb-1 text-[9px] text-[#667781] max-w-[80px]">{img.name}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 入居日（任意） */}
            <section>
              <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accent }}>📅 入居日（任意）</div>
              <div className="rounded-2xl bg-white shadow-sm px-4 py-3 flex items-center gap-3">
                <input
                  type="date"
                  className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2.5 text-[15px] font-semibold outline-none focus:border-blue-400"
                  value={step1MoveInDate}
                  onChange={(e) => setStep1MoveInDate(e.target.value)}
                />
                <div className="text-[11px] text-[#667781] leading-snug text-right min-w-[64px]">
                  {step1MoveInDate ? (
                    (() => {
                      const { moveInDay, moveInMonth } = calcMoveInInfo(step1MoveInDate);
                      return moveInDay > 1
                        ? <span className="text-orange-500 font-semibold">{moveInMonth}月{moveInDay}日<br/>日割りあり</span>
                        : <span className="text-emerald-600 font-semibold">{moveInMonth}月1日<br/>日割りなし</span>;
                    })()
                  ) : (
                    <span className="text-[#aaa]">未設定<br/>（1日入居）</span>
                  )}
                </div>
              </div>
            </section>

            {/* 補足情報テキスト */}
            <section>
              <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accent }}>
                補足情報（任意）
              </div>
              <div className="rounded-2xl bg-white shadow-sm p-4">
                <textarea
                  className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3] placeholder:text-[#aaa]"
                  rows={5}
                  placeholder={"物件名・家賃・入居日など文字情報があれば入力してください\n\n例：\n物件名: グランドマンション202\n家賃: 85,000円 / 管理費: 5,000円\n入居予定: 2026年7月1日\n敷金1ヶ月 / 礼金1ヶ月\n仲介手数料 93,500円（税込）"}
                  value={supplementaryText}
                  onChange={(e) => setSupplementaryText(e.target.value)}
                />
              </div>
            </section>

            {extractError && (
              <div className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-600">{extractError}</div>
            )}

            {/* AI読み取りボタン */}
            <button
              onClick={handleExtract}
              disabled={extracting}
              className="w-full rounded-full py-4 text-[15px] font-bold text-white shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ background: cfg.grad }}
            >
              {extracting ? (
                <>
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  AI読み取り中...（10〜20秒かかります）
                </>
              ) : (
                "🔍 AIで読み取る"
              )}
            </button>

            {/* 手動入力ボタン */}
            <button
              onClick={() => {
                setItems(makeBlankItems(account, step1MoveInDate));
                setStep("review");
                setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
              }}
              className="w-full rounded-full py-3 text-[13px] font-bold border-2 flex items-center justify-center gap-2"
              style={{ borderColor: cfg.accent, color: cfg.accent, background: "white" }}
            >
              ✏️ 手動で入力する（画像なし）
            </button>

            <div className="h-4" />
          </div>
        )}

        {/* ─── STEP 2: 確認・調整 ─── */}
        {step === "review" && items && (
          <div ref={reviewRef} className="p-4 flex flex-col gap-4">

            {/* 入居日選択カード */}
            <section className="rounded-2xl bg-white shadow-sm overflow-hidden">
              <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: cfg.grad }}>
                <span className="text-[14px] font-bold text-white">📅 入居日</span>
                <span className="text-[11px] text-white/70">日付で日割り家賃が自動計算されます</span>
              </div>
              <div className="px-4 py-3 flex items-center gap-3">
                <input
                  type="date"
                  className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2.5 text-[15px] font-semibold outline-none focus:border-blue-400"
                  value={items.moveInDate || ""}
                  onChange={(e) => updateItem("moveInDate", e.target.value)}
                />
                <div className="text-[11px] text-[#667781] leading-snug text-right">
                  {items.moveInDay > 1
                    ? <span className="text-orange-500 font-semibold">{items.moveInMonth}月{items.moveInDay}日入居<br/>日割りあり</span>
                    : items.moveInMonth > 0
                      ? <span className="text-emerald-600 font-semibold">{items.moveInMonth}月1日入居<br/>日割りなし</span>
                      : <span>未設定</span>
                  }
                </div>
              </div>
            </section>

            {/* プレビュー：費用合計 */}
            <section className="rounded-2xl bg-white shadow-sm overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between" style={{ background: cfg.grad }}>
                <div className="text-[15px] font-bold text-white">費用プレビュー</div>
                <div className="text-[12px] text-white/80">
                  {items.customerName ? `${items.customerName}様` : ""} {items.propertyName}
                </div>
              </div>
              <div className="px-4 pb-1 pt-2">
                <p className="text-[10px] text-[#aab] mb-1">金額をタップして直接編集できます　※日割りは自動計算　※その他費用は税込金額をそのまま入力</p>
              </div>
              <div className="px-4 pb-4">
                <table className="w-full text-[12px]">
                  <tbody>
                    {totalItems.map((row, idx) => (
                      <tr key={idx} className={row.isDiscount ? "text-red-500 font-bold" : ""}>
                        <td className="py-0.5 pr-2 text-[#54656f] align-middle">
                          {row.otherIdx !== undefined ? (
                            <input
                              type="text"
                              className="w-full text-[12px] border-b border-[#d1d7db] focus:border-blue-400 outline-none bg-transparent text-[#54656f] placeholder:text-[#ccc]"
                              placeholder="項目名"
                              value={row.label}
                              onChange={(e) => updateOtherItem(row.otherIdx!, "item", e.target.value)}
                            />
                          ) : row.editKey === "guarantee" ? (
                            <div className="flex items-center gap-1.5">
                              <span>賃貸保証料</span>
                              <div className="flex items-center gap-0.5">
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  className="w-9 rounded border border-[#d1d7db] px-1 py-0.5 text-[11px] text-center outline-none focus:border-blue-400 bg-white tabular-nums"
                                  value={String(items?.guaranteeRate || 0)}
                                  onChange={(e) => updateItem("guaranteeRate", Number(e.target.value) || 0)}
                                />
                                <span className="text-[10px] text-[#90a4ae]">%</span>
                              </div>
                            </div>
                          ) : (
                            <>{row.label}{row.isComputed && <span className="ml-1 text-[9px] text-[#b0bec5]">自動</span>}</>
                          )}
                        </td>
                        <td className="py-0.5 text-right align-middle">
                          {row.isComputed ? (
                            <span className="font-semibold tabular-nums text-[#90a4ae]">{fmtYen(row.amount)}</span>
                          ) : row.otherIdx !== undefined ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <span className="text-[11px] text-[#90a4ae]">¥</span>
                              <input
                                type="number"
                                min="0"
                                className="w-20 text-right text-[12px] font-semibold border-b border-[#d1d7db] focus:border-blue-400 outline-none bg-transparent text-[#111b21] tabular-nums"
                                value={String(row.amount || 0)}
                                onChange={(e) => updateOtherItem(row.otherIdx!, "amount", e.target.value)}
                              />
                              <button
                                onClick={() => removeOtherItem(row.otherIdx!)}
                                className="ml-1 text-[#ccc] active:text-red-400 text-base leading-none"
                              >×</button>
                            </div>
                          ) : row.isDiscount ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <span className="text-[11px]">▲¥</span>
                              <input
                                type="number"
                                min="0"
                                className="w-24 text-right text-[12px] font-bold border-b border-red-200 focus:border-red-400 outline-none bg-transparent text-red-500 tabular-nums"
                                value={String(items?.discountAmount || 0)}
                                onChange={(e) => updateItem("discountAmount", Number(e.target.value) || 0)}
                                onFocus={(e) => e.target.select()}
                              />
                            </div>
                          ) : row.editKey ? (
                            <div className="flex items-center justify-end gap-0.5">
                              <span className="text-[11px] text-[#90a4ae]">¥</span>
                              <input
                                type="number"
                                min="0"
                                className="w-24 text-right text-[12px] font-semibold border-b border-[#d1d7db] focus:border-blue-400 outline-none bg-transparent text-[#111b21] tabular-nums"
                                value={String((items?.[row.editKey] as number) || 0)}
                                onChange={(e) => updateItem(row.editKey!, Number(e.target.value) || 0)}
                                onFocus={(e) => e.target.select()}
                              />
                            </div>
                          ) : (
                            <span className="font-semibold text-[#111b21] tabular-nums">
                              {fmtYen(row.amount)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[#e9edef]">
                      <td className="pt-2 font-bold text-[#111b21]">合計（目安）</td>
                      <td className="pt-2 text-right text-[17px] font-bold tabular-nums" style={{ color: cfg.accent }}>
                        {fmtYen(grandTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <div className="mt-2 text-right">
                  <button
                    onClick={addOtherItem}
                    className="rounded-full px-3 py-1 text-[11px] font-bold text-white"
                    style={{ background: cfg.accent }}
                  >＋ その他費用を追加</button>
                </div>
              </div>
            </section>

            {/* 各項目の確認・調整フォーム */}
            {GROUP_ORDER.map((groupName) => {
              const groupItems = groups[groupName];
              if (!groupItems || groupItems.length === 0) return null;
              return (
                <section key={groupName}>
                  <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accent }}>{groupName}</div>
                  <div className="rounded-2xl bg-white p-4 shadow-sm flex flex-col gap-2.5">
                    {groupItems.map(({ key, label, derived }) => {
                      const isText = TEXT_KEYS.has(key);
                      const val = items[key as keyof EditableItems];
                      return (
                        <div key={key}>
                          <label className="mb-1 block text-[11px] text-[#667781]">{label}</label>
                          {derived ? (
                            // 自動計算フィールド → read-only表示
                            <div className="w-full rounded-xl border border-[#e9edef] bg-[#f5f6f7] px-3 py-2 text-[13px] text-[#667781]">
                              {String(val || 0)} 日
                            </div>
                          ) : isText ? (
                            <input
                              type={key === "moveInDate" ? "date" : "text"}
                              className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                              value={String(val || "")}
                              onChange={(e) => updateItem(key, e.target.value)}
                            />
                          ) : PERCENT_KEYS.has(key as string) ? (
                            <div className="flex items-center gap-2">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  className="w-20 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                                  value={String(val || 0)}
                                  onChange={(e) => updateItem(key, Number(e.target.value) || 0)}
                                />
                                <span className="text-[13px] text-[#667781]">%</span>
                              </div>
                              <span className="text-[11px] text-[#b0bec5]">
                                → {fmtYen(Math.round((items?.rent || 0) * (Number(val) || 0) / 100))}
                              </span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <span className="text-[13px] text-[#667781]">¥</span>
                              <input
                                type="number"
                                className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                                value={String(val || 0)}
                                onChange={(e) => updateItem(key, Number(e.target.value) || 0)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {/* その他費用 */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="text-[12px] font-bold" style={{ color: cfg.accent }}>その他費用</div>
                  <span className="text-[10px] text-[#667781] bg-[#f0f2f5] rounded px-1.5 py-0.5">税込金額をそのまま入力</span>
                </div>
                <button
                  onClick={addOtherItem}
                  className="rounded-full px-3 py-1 text-[11px] font-bold text-white"
                  style={{ background: cfg.accent }}
                >
                  ＋ 追加
                </button>
              </div>
              {items.otherItems.length > 0 && (
                <div className="rounded-2xl bg-white p-4 shadow-sm flex flex-col gap-2.5">
                  {items.otherItems.map((o, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                        placeholder="項目名"
                        value={o.item}
                        onChange={(e) => updateOtherItem(idx, "item", e.target.value)}
                      />
                      <div className="flex items-center gap-1">
                        <span className="text-[12px] text-[#667781]">¥</span>
                        <input
                          type="number"
                          className="w-24 rounded-xl border border-[#d1d7db] px-2 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                          value={String(o.amount || 0)}
                          onChange={(e) => updateOtherItem(idx, "amount", e.target.value)}
                        />
                      </div>
                      <button
                        onClick={() => removeOtherItem(idx)}
                        className="text-[#ccc] hover:text-red-400 text-lg leading-none"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 補足情報 */}
            <section>
              <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accent }}>特記事項・メモ</div>
              <div className="rounded-2xl bg-white p-4 shadow-sm">
                <textarea
                  className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                  rows={3}
                  placeholder="見積書に記載する特記事項があれば入力"
                  value={items.supplementaryNotes || ""}
                  onChange={(e) => updateItem("supplementaryNotes", e.target.value)}
                />
              </div>
            </section>

            {downloadError && (
              <div className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-600">{downloadError}</div>
            )}

            {/* 見積書作成ボタン */}
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="w-full rounded-full py-4 text-[15px] font-bold text-white shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ background: cfg.grad }}
            >
              {downloading ? (
                <>
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Excelファイルを作成中...
                </>
              ) : (
                "📄 見積書を作成（Excel ダウンロード）"
              )}
            </button>

            {/* LINE送付ボタン */}
            <button
              onClick={handleLinePreview}
              className="w-full rounded-full py-4 text-[15px] font-bold text-white shadow-lg flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg,#00B900,#00C300)" }}
            >
              💬 LINE用テキストを生成
            </button>

            {/* 画像化してLINEへ送るボタン */}
            <button
              onClick={handleCaptureAndShare}
              disabled={capturing}
              className="w-full rounded-full py-4 text-[15px] font-bold text-white shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: "linear-gradient(135deg,#FF6B6B,#FF8E53)" }}
            >
              {capturing ? (
                <>
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  画像を生成中...
                </>
              ) : (
                "📲 見積書を画像化してグループに送る"
              )}
            </button>

            <div className="h-4" />
          </div>
        )}
      </div>

      <BottomNav />

      {/* 画像化用 隠しDiv（画面外に配置・html2canvasでキャプチャ） */}
      {items && (
        <div
          ref={printRef}
          style={{
            position: "fixed",
            left: -9999,
            top: 0,
            width: 360,
            background: "#fff",
            fontFamily: "'Hiragino Sans', 'Noto Sans JP', sans-serif",
          }}
        >
          {/* ヘッダー */}
          <div style={{ background: cfg.grad, padding: "16px 20px" }}>
            <div style={{ fontSize: 18, fontWeight: "bold", color: "#fff", marginBottom: 4 }}>
              {cfg.label} 初期費用見積書
            </div>
            {(items.propertyName || items.roomNumber) && (
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)" }}>
                {items.propertyName}{items.roomNumber ? `　${items.roomNumber}号室` : ""}
              </div>
            )}
            {items.customerName && (
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)" }}>
                {items.customerName} 様
              </div>
            )}
          </div>

          {/* 費用一覧 */}
          <div style={{ padding: "16px 20px 8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {totalItems.filter(r => r.amount !== 0 || r.alwaysShow).map((row, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid #f0f2f5" }}>
                    <td style={{ padding: "6px 0", color: row.isDiscount ? "#e53e3e" : "#54656f" }}>
                      {row.label}
                      {row.isComputed && <span style={{ fontSize: 10, color: "#b0bec5", marginLeft: 4 }}>自動</span>}
                    </td>
                    <td style={{ padding: "6px 0", textAlign: "right", fontWeight: 600, color: row.isDiscount ? "#e53e3e" : "#111b21" }}>
                      {row.isDiscount
                        ? `▲¥${Math.abs(row.amount).toLocaleString()}`
                        : `¥${(row.amount || 0).toLocaleString()}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ paddingTop: 12, fontWeight: "bold", fontSize: 15, color: "#111b21", borderTop: "2px solid #e9edef" }}>
                    合計（目安）
                  </td>
                  <td style={{ paddingTop: 12, textAlign: "right", fontSize: 18, fontWeight: "bold", color: cfg.accent, borderTop: "2px solid #e9edef" }}>
                    ¥{grandTotal.toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* 節約額 */}
          {(() => {
            const standardCommission = Math.round((items.rent || 0) * 1.1);
            const actualCommission = (items.commission || 0) + (items.commissionTax || 0);
            const savings = Math.max(0, standardCommission - actualCommission + (items.discountAmount || 0));
            return savings > 0 ? (
              <div style={{ margin: "0 20px 16px", background: "#fff9e6", border: "1px solid #ffe082", borderRadius: 12, padding: "10px 16px", fontSize: 13, color: "#7b5e00", fontWeight: 600, textAlign: "center" }}>
                {ACCOUNT_SAVINGS_TEMPLATE[account](savings)}
              </div>
            ) : null;
          })()}

          {/* フッター */}
          <div style={{ background: "#f0f2f5", padding: "10px 20px", fontSize: 11, color: "#90a4ae", textAlign: "center" }}>
            ※こちらは概算見積もりです。実際の金額は異なる場合があります。
          </div>
        </div>
      )}

      {/* LINE テキストモーダル */}
      {lineModal && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setLineModal(false)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl bg-white"
            style={{ paddingBottom: "max(20px,env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between border-b border-[#e9edef] px-5 py-4">
              <div className="text-[15px] font-bold text-[#111b21]">💬 LINE送付テキスト</div>
              <button
                onClick={() => setLineModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f0f2f5] text-[18px] leading-none text-[#667781]"
              >
                ×
              </button>
            </div>

            {/* テキストプレビュー */}
            <div className="max-h-[52vh] overflow-y-auto px-5 py-3">
              <pre className="whitespace-pre-wrap rounded-xl bg-[#f0f2f5] p-3 font-sans text-[12px] leading-relaxed text-[#111b21]">
                {lineText}
              </pre>
            </div>

            {/* コピーボタン */}
            <div className="px-5 pt-3">
              <button
                onClick={handleCopy}
                className="flex w-full items-center justify-center gap-2 rounded-full py-4 text-[15px] font-bold text-white shadow transition-all"
                style={{ background: lineCopied ? "#28a745" : "linear-gradient(135deg,#00B900,#00C300)" }}
              >
                {lineCopied ? "✅ コピーしました！LINEに貼り付けて送信" : "📋 コピーしてLINEで送る"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
