"use client";

import { useEffect, useRef, useState } from "react";
import BottomNav from "../components/BottomNav";

type Account = "sumora" | "ieyasu" | "giga";

type EstimateItem = {
  item: string;
  amount: number;
  category: string;
  notes: string;
};

type EstimateResult = {
  id?: string;
  items: EstimateItem[];
  subtotal: number;
  discountAmount: number;
  discountBreakdown: string;
  total: number;
  lineText: string;
};

type SavedEstimate = {
  id: string;
  account: Account;
  customer_name: string;
  property_name: string;
  move_in_date: string;
  total: number;
  created_at: string;
};

const ACCOUNT_CONFIG: Record<Account, {
  label: string;
  accentColor: string;
  headerGrad: string;
  defaultInsurance: number;
  defaultKeyExchange: number;
  commissionRate: number;
}> = {
  sumora: {
    label: "スモラ",
    accentColor: "#1565C0",
    headerGrad: "linear-gradient(135deg, #1565C0, #2196F3, #4BA8E8)",
    defaultInsurance: 14000,
    defaultKeyExchange: 16500,
    commissionRate: 1.1,
  },
  ieyasu: {
    label: "イエヤス",
    accentColor: "#e65100",
    headerGrad: "linear-gradient(135deg, #bf360c, #e65100, #ff6d00)",
    defaultInsurance: 14000,
    defaultKeyExchange: 16500,
    commissionRate: 1.1,
  },
  giga: {
    label: "ギガ賃貸",
    accentColor: "#1b5e20",
    headerGrad: "linear-gradient(135deg, #1b5e20, #2e7d32, #43a047)",
    defaultInsurance: 14000,
    defaultKeyExchange: 16500,
    commissionRate: 1.1,
  },
};

const CATEGORY_LABEL: Record<string, string> = {
  shikikin: "敷金",
  reikin: "礼金",
  prorated_rent: "日割賃料",
  prorated_fee: "日割管理費",
  next_rent: "翌月賃料",
  next_fee: "翌月管理費",
  commission: "仲介手数料",
  discount: "割引",
  key: "鍵交換",
  insurance: "火災保険",
  guarantee: "保証料",
  cleaning: "クリーニング",
  other: "その他",
};

function fmtYen(n: number) {
  const abs = Math.abs(n);
  const prefix = n < 0 ? "▲" : "";
  return `${prefix}¥${abs.toLocaleString()}`;
}

export default function EstimatePage() {
  const [account, setAccount] = useState<Account>("sumora");
  const cfg = ACCOUNT_CONFIG[account];

  // 入力フォーム
  const [customerName, setCustomerName] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [moveInDate, setMoveInDate] = useState("");
  const [rent, setRent] = useState("");
  const [managementFee, setManagementFee] = useState("");
  const [shikikinMonths, setShikikinMonths] = useState("1");
  const [reikinMonths, setReikinMonths] = useState("1");
  const [useCustomCommission, setUseCustomCommission] = useState(false);
  const [customCommission, setCustomCommission] = useState("");
  const [guarantee, setGuarantee] = useState("");
  const [insurance, setInsurance] = useState(String(cfg.defaultInsurance));
  const [keyExchange, setKeyExchange] = useState(String(cfg.defaultKeyExchange));
  const [cleaning, setCleaning] = useState("");
  const [otherItems, setOtherItems] = useState<Array<{ item: string; amount: string; notes: string }>>([]);
  const [discountAmount, setDiscountAmount] = useState("");
  const [discountNote, setDiscountNote] = useState("");
  const [supplementaryNotes, setSupplementaryNotes] = useState("");

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [error, setError] = useState("");
  const [copyDone, setCopyDone] = useState(false);

  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<SavedEstimate[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const resultRef = useRef<HTMLDivElement>(null);

  // アカウント切替時にデフォルト値更新
  useEffect(() => {
    const c = ACCOUNT_CONFIG[account];
    setInsurance(String(c.defaultInsurance));
    setKeyExchange(String(c.defaultKeyExchange));
  }, [account]);

  // 賃料変更時に保証料を自動計算（50%）
  useEffect(() => {
    if (rent && !guarantee) {
      setGuarantee(String(Math.round(Number(rent) * 0.5)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rent]);

  const addOtherItem = () => {
    setOtherItems((p) => [...p, { item: "", amount: "", notes: "" }]);
  };

  const removeOtherItem = (idx: number) => {
    setOtherItems((p) => p.filter((_, i) => i !== idx));
  };

  const updateOtherItem = (idx: number, field: "item" | "amount" | "notes", val: string) => {
    setOtherItems((p) => p.map((o, i) => i === idx ? { ...o, [field]: val } : o));
  };

  const handleGenerate = async () => {
    if (!rent || Number(rent) <= 0) { setError("賃料を入力してください"); return; }
    setError("");
    setGenerating(true);
    setResult(null);

    try {
      const res = await fetch("/api/generate-estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account,
          customerName: customerName.trim(),
          propertyName: propertyName.trim(),
          moveInDate,
          rent: Number(rent),
          managementFee: Number(managementFee) || 0,
          shikikinMonths: Number(shikikinMonths) || 0,
          reikinMonths: Number(reikinMonths) || 0,
          commissionRate: cfg.commissionRate,
          customCommission: useCustomCommission ? (Number(customCommission) || null) : null,
          guarantee: Number(guarantee) || 0,
          insurance: Number(insurance) || 0,
          keyExchange: Number(keyExchange) || 0,
          cleaning: Number(cleaning) || 0,
          otherItems: otherItems
            .filter((o) => o.item && Number(o.amount) > 0)
            .map((o) => ({ item: o.item, amount: Number(o.amount), notes: o.notes })),
          discountAmount: Number(discountAmount) || 0,
          discountNote: discountNote.trim(),
          supplementaryNotes: supplementaryNotes.trim(),
        }),
      });

      const data = await res.json() as EstimateResult & { error?: string };
      if (data.error) { setError(data.error); return; }
      setResult(data);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch {
      setError("見積書の生成に失敗しました。もう一度お試しください。");
    } finally {
      setGenerating(false);
    }
  };

  const copyLineText = () => {
    if (!result?.lineText) return;
    navigator.clipboard.writeText(result.lineText).then(() => {
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 2000);
    });
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/generate-estimate?account=${account}&limit=20`);
      const data = await res.json() as { ok: boolean; estimates: SavedEstimate[] };
      if (data.ok) setHistory(data.estimates);
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleHistory = () => {
    if (!showHistory) loadHistory();
    setShowHistory((v) => !v);
  };

  return (
    <main
      className="flex h-[calc(100svh-56px)] flex-col overflow-hidden"
      style={{ background: "linear-gradient(180deg, #f0f7ff 0%, #eef6ff 60%, #f5faff 100%)" }}
    >
      {/* ヘッダー */}
      <header
        className="shrink-0 px-4 pb-3 pt-[max(10px,env(safe-area-inset-top))]"
        style={{ background: cfg.headerGrad }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[17px] font-bold text-white">見積書作成</div>
          <button
            onClick={toggleHistory}
            className="rounded-full bg-white/20 px-3 py-1 text-[11px] font-bold text-white"
          >
            履歴
          </button>
        </div>

        {/* アカウント選択 */}
        <div className="flex gap-2">
          {(["sumora", "ieyasu", "giga"] as Account[]).map((a) => (
            <button
              key={a}
              onClick={() => { setAccount(a); setResult(null); }}
              className="flex-1 rounded-full py-1.5 text-[13px] font-bold transition"
              style={
                account === a
                  ? { backgroundColor: "white", color: cfg.accentColor }
                  : { backgroundColor: "rgba(255,255,255,0.2)", color: "white" }
              }
            >
              {ACCOUNT_CONFIG[a].label}
            </button>
          ))}
        </div>
      </header>

      {/* スクロール領域 */}
      <div className="flex-1 overflow-y-auto">

        {/* 履歴パネル */}
        {showHistory && (
          <div className="border-b border-[#e9edef] bg-white px-4 py-3">
            <div className="mb-2 text-[13px] font-bold text-[#1565C0]">過去の見積書（{ACCOUNT_CONFIG[account].label}）</div>
            {historyLoading ? (
              <div className="py-4 text-center text-[12px] text-[#aaa]">読み込み中...</div>
            ) : history.length === 0 ? (
              <div className="py-4 text-center text-[12px] text-[#aaa]">まだ見積書がありません</div>
            ) : (
              <div className="flex flex-col gap-2">
                {history.map((h) => (
                  <div key={h.id} className="flex items-center justify-between rounded-xl bg-[#f8f9fa] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-[#111b21]">
                        {h.customer_name || "（名前なし）"} — {h.property_name || "（物件名なし）"}
                      </div>
                      <div className="text-[11px] text-[#667781]">
                        {h.move_in_date ? `入居 ${h.move_in_date}` : "入居日未定"} / 合計 ¥{h.total.toLocaleString()}
                      </div>
                    </div>
                    <div className="ml-2 shrink-0 text-[11px] text-[#aaa]">
                      {new Date(h.created_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* フォーム */}
        <div className="p-4 flex flex-col gap-5">

          {/* 基本情報 */}
          <section>
            <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accentColor }}>基本情報</div>
            <div className="flex flex-col gap-2.5 rounded-2xl bg-white p-4 shadow-sm">
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">お客様名</label>
                <input
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                  placeholder="例：田中 太郎"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">物件名</label>
                <input
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                  placeholder="例：グランドマンション502号室"
                  value={propertyName}
                  onChange={(e) => setPropertyName(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">入居予定日（日割り計算に使用）</label>
                <input
                  type="date"
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                  value={moveInDate}
                  onChange={(e) => setMoveInDate(e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* 賃料情報 */}
          <section>
            <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accentColor }}>賃料情報</div>
            <div className="flex flex-col gap-2.5 rounded-2xl bg-white p-4 shadow-sm">
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">月額賃料 *</label>
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#667781]">¥</span>
                  <input
                    type="number"
                    className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    placeholder="例：100000"
                    value={rent}
                    onChange={(e) => setRent(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">管理費・共益費（月額）</label>
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#667781]">¥</span>
                  <input
                    type="number"
                    className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    placeholder="例：5000（なければ0）"
                    value={managementFee}
                    onChange={(e) => setManagementFee(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* 初期費用設定 */}
          <section>
            <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accentColor }}>初期費用設定</div>
            <div className="flex flex-col gap-2.5 rounded-2xl bg-white p-4 shadow-sm">
              {/* 敷金・礼金 */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="mb-1 block text-[11px] text-[#667781]">敷金（ヶ月）</label>
                  <div className="flex gap-1">
                    {["0", "1", "2", "3"].map((v) => (
                      <button
                        key={v}
                        onClick={() => setShikikinMonths(v)}
                        className="flex-1 rounded-lg py-1.5 text-[12px] font-bold transition"
                        style={
                          shikikinMonths === v
                            ? { background: cfg.accentColor, color: "white" }
                            : { background: "#f0f2f5", color: "#54656f" }
                        }
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-[#667781]">礼金（ヶ月）</label>
                  <div className="flex gap-1">
                    {["0", "1", "2", "3"].map((v) => (
                      <button
                        key={v}
                        onClick={() => setReikinMonths(v)}
                        className="flex-1 rounded-lg py-1.5 text-[12px] font-bold transition"
                        style={
                          reikinMonths === v
                            ? { background: cfg.accentColor, color: "white" }
                            : { background: "#f0f2f5", color: "#54656f" }
                        }
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 仲介手数料 */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-[11px] text-[#667781]">仲介手数料</label>
                  <button
                    onClick={() => setUseCustomCommission((v) => !v)}
                    className="text-[11px] font-bold"
                    style={{ color: cfg.accentColor }}
                  >
                    {useCustomCommission ? "賃料×1.1に戻す" : "金額を直接入力"}
                  </button>
                </div>
                {useCustomCommission ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[13px] text-[#667781]">¥</span>
                    <input
                      type="number"
                      className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                      placeholder="例：110000"
                      value={customCommission}
                      onChange={(e) => setCustomCommission(e.target.value)}
                    />
                  </div>
                ) : (
                  <div className="rounded-xl bg-[#f0f2f5] px-3 py-2 text-[13px] text-[#54656f]">
                    賃料 × 1.1（税込）= {rent ? `¥${Math.round(Number(rent) * 1.1).toLocaleString()}` : "賃料入力後に表示"}
                  </div>
                )}
              </div>

              {/* 保証料 */}
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">保証料（初回）</label>
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#667781]">¥</span>
                  <input
                    type="number"
                    className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    placeholder="例：50000"
                    value={guarantee}
                    onChange={(e) => setGuarantee(e.target.value)}
                  />
                </div>
              </div>

              {/* 火災保険 */}
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">火災保険</label>
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#667781]">¥</span>
                  <input
                    type="number"
                    className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    value={insurance}
                    onChange={(e) => setInsurance(e.target.value)}
                  />
                </div>
              </div>

              {/* 鍵交換 */}
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">鍵交換費用</label>
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#667781]">¥</span>
                  <input
                    type="number"
                    className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    value={keyExchange}
                    onChange={(e) => setKeyExchange(e.target.value)}
                  />
                </div>
              </div>

              {/* クリーニング */}
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">ハウスクリーニング（任意）</label>
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#667781]">¥</span>
                  <input
                    type="number"
                    className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    placeholder="0"
                    value={cleaning}
                    onChange={(e) => setCleaning(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* その他項目 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[12px] font-bold" style={{ color: cfg.accentColor }}>その他費用</div>
              <button
                onClick={addOtherItem}
                className="rounded-full px-3 py-1 text-[11px] font-bold text-white"
                style={{ background: cfg.accentColor }}
              >
                ＋ 追加
              </button>
            </div>
            {otherItems.length > 0 && (
              <div className="flex flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm">
                {otherItems.map((o, idx) => (
                  <div key={idx} className="flex gap-2 items-start">
                    <div className="flex-1 flex flex-col gap-1">
                      <input
                        className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                        placeholder="項目名（例: 駐車場）"
                        value={o.item}
                        onChange={(e) => updateOtherItem(idx, "item", e.target.value)}
                      />
                      <div className="flex items-center gap-1">
                        <span className="text-[13px] text-[#667781]">¥</span>
                        <input
                          type="number"
                          className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                          placeholder="金額"
                          value={o.amount}
                          onChange={(e) => updateOtherItem(idx, "amount", e.target.value)}
                        />
                      </div>
                    </div>
                    <button
                      onClick={() => removeOtherItem(idx)}
                      className="mt-1 text-[#ccc] hover:text-red-400 text-lg leading-none"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 割引 */}
          <section>
            <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accentColor }}>割引（AIが適用方法を判断）</div>
            <div className="flex flex-col gap-2.5 rounded-2xl bg-white p-4 shadow-sm">
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">割引額</label>
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#667781]">¥</span>
                  <input
                    type="number"
                    className="flex-1 rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                    placeholder="例：30000"
                    value={discountAmount}
                    onChange={(e) => setDiscountAmount(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-[#667781]">割引メモ（任意）</label>
                <input
                  className="w-full rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                  placeholder="例：仲介手数料半額キャンペーン"
                  value={discountNote}
                  onChange={(e) => setDiscountNote(e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* 補足情報 */}
          <section>
            <div className="mb-2 text-[12px] font-bold" style={{ color: cfg.accentColor }}>補足情報・資料メモ</div>
            <div className="rounded-2xl bg-white p-4 shadow-sm">
              <textarea
                className="w-full resize-none rounded-xl border border-[#d1d7db] px-3 py-2 text-[13px] outline-none focus:border-[#2196F3]"
                rows={4}
                placeholder="物件の特記事項、管理会社からの指定費用、お客様への説明メモなど自由に入力してください&#10;&#10;例：&#10;・敷金は退去時に返還あり&#10;・保証会社は〇〇保証のみ&#10;・礼金は交渉可能"
                value={supplementaryNotes}
                onChange={(e) => setSupplementaryNotes(e.target.value)}
              />
            </div>
          </section>

          {/* エラー表示 */}
          {error && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-600">{error}</div>
          )}

          {/* 生成ボタン */}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="w-full rounded-full py-4 text-[15px] font-bold text-white shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ background: cfg.headerGrad }}
          >
            {generating ? (
              <>
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                AI見積書を生成中...
              </>
            ) : (
              "✨ AI見積書を生成する"
            )}
          </button>

          {/* 生成結果 */}
          {result && (
            <div ref={resultRef} className="flex flex-col gap-3">
              <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
                {/* 結果ヘッダー */}
                <div
                  className="px-4 py-3"
                  style={{ background: cfg.headerGrad }}
                >
                  <div className="text-[15px] font-bold text-white">見積書（{ACCOUNT_CONFIG[account].label}）</div>
                  {customerName && (
                    <div className="text-[12px] text-white/80">{customerName} 様 / {propertyName || "物件名なし"}</div>
                  )}
                </div>

                {/* 費用明細 */}
                <div className="p-4">
                  <table className="w-full text-[13px]">
                    <tbody>
                      {result.items.map((item, idx) => (
                        <tr
                          key={idx}
                          className={item.category === "discount" ? "text-red-500 font-bold" : ""}
                        >
                          <td className="py-1.5 pr-2 text-[#54656f]">
                            <div className="leading-tight">{item.item}</div>
                            {item.notes && (
                              <div className="text-[10px] text-[#8696a0]">{item.notes}</div>
                            )}
                          </td>
                          <td className="py-1.5 text-right font-semibold text-[#111b21] whitespace-nowrap">
                            {fmtYen(item.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-[#e9edef]">
                        <td className="pt-2 font-bold text-[#111b21]">合計（目安）</td>
                        <td className="pt-2 text-right text-[17px] font-bold" style={{ color: cfg.accentColor }}>
                          ¥{result.total.toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>

                  {result.discountBreakdown && (
                    <div className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                      ✨ AIの割引適用: {result.discountBreakdown}
                    </div>
                  )}
                </div>
              </div>

              {/* LINE テキスト */}
              {result.lineText && (
                <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-[#f0f2f5]">
                    <div className="text-[13px] font-bold text-[#1565C0]">LINE送付用テキスト</div>
                    <button
                      onClick={copyLineText}
                      className="rounded-full px-3 py-1 text-[11px] font-bold text-white"
                      style={{ background: copyDone ? "#43a047" : "#25D366" }}
                    >
                      {copyDone ? "✓ コピー済み" : "コピー"}
                    </button>
                  </div>
                  <div className="p-4">
                    <pre className="whitespace-pre-wrap text-[12px] leading-[1.7] text-[#111b21] font-sans">
                      {result.lineText}
                    </pre>
                  </div>
                </div>
              )}

              {/* 再生成ボタン */}
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="w-full rounded-full border-2 py-3 text-[13px] font-bold disabled:opacity-50"
                style={{ borderColor: cfg.accentColor, color: cfg.accentColor }}
              >
                再生成する
              </button>
            </div>
          )}

          {/* 下部余白 */}
          <div className="h-4" />
        </div>
      </div>

      <BottomNav />
    </main>
  );
}
