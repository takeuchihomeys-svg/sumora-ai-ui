"use client";
// app/components/EstimateWatchPanel.tsx
// 見積書作成の画面の「監視」の板（読むだけ）。LINE の会話から来た時だけ出す。
//
// 2026-10-01 竹内「見積書きかれたら…見積書のツールのところに連携されるようにする（見積書の画面にも監視する部分配置）」
//   出す物: お客様・今の段階／見積書のお部屋（出所・AD・家賃）と選び直し／最近のお客様の発言／送った物／ブレインの判断／警告
//   値は GET /api/estimate-handoff（estimate-handoff-server.ts・LLM を呼ばない）
import type { EstimateHandoff, EstimateTarget } from "../lib/estimate-handoff";

const ACCOUNT_LABEL: Record<string, string> = { sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ賃貸" };
const AIX_LABEL: Record<string, string> = {
  estimate_sheet: "見積書送る", property_recommendation: "物件オススメ", property_send: "物件ピックアップ",
  property_check_result: "物件確認した", viewing_invite: "内覧へ", application_push: "申込へ", meeting_place: "待ち合わせ",
  acknowledge_check: "確認します",
};
const md = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const yen = (n: number | null | undefined) => (n == null ? "?" : `${n.toLocaleString()}円`);
const roomLabel = (t: EstimateTarget) => `${t.name || "（名前は資料から読む）"}${t.room ? ` ${t.room}号室` : ""}`;

export default function EstimateWatchPanel({ handoff, selected, onSelect, accent }: {
  handoff: EstimateHandoff;
  selected: EstimateTarget | null;
  onSelect: (t: EstimateTarget) => void;
  accent: string;
}) {
  const w = handoff.watch;
  const c = handoff.choice;
  const alts = [c.target, ...c.candidates, ...c.others].filter((x): x is EstimateTarget => !!x && x !== selected);
  return (
    <section className="rounded-2xl border border-[#cfd8dc] bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2" style={{ background: "#eceff1" }}>
        <div className="text-[12px] font-bold text-[#37474f]">
          🛰 監視 · {handoff.customerName || "お客様"}（{ACCOUNT_LABEL[handoff.account] ?? handoff.account}）
          {w.stageLabel && <span className="ml-1 font-normal text-[#607d8b]">· {w.stageLabel}</span>}
        </div>
        <a href={`/?conv=${encodeURIComponent(handoff.conversationId)}`} className="rounded-full bg-white px-2.5 py-0.5 text-[11px] font-bold text-[#455a64]">LINE に戻る</a>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2 text-[11px] text-[#455a64]">
        {w.headline && <div className="text-[#37474f]">{w.headline}</div>}

        {/* 見積書のお部屋 */}
        <div className="rounded-xl border px-2.5 py-2" style={{ borderColor: accent }}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[12px] font-bold text-[#111b21]">🏠 {selected ? roomLabel(selected) : "お部屋を選んでください"}</span>
            {selected && <span className="rounded bg-[#e3f2fd] px-1.5 py-0.5 text-[10px] text-[#1565c0]">出所: {selected.sourceLabel}</span>}
          </div>
          {selected && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>家賃 {yen(selected.rent)}{selected.managementFee != null ? `／管理費 ${yen(selected.managementFee)}` : ""}</span>
              {/* AD はスタッフにだけ見せる（お客様に送る見積書・本文には出さない） */}
              <span className="font-bold text-[#6a1b9a]">
                AD {selected.adMonths != null ? `${selected.adMonths}ヶ月` : "?"}{selected.adYen != null ? `（${yen(selected.adYen)}）` : ""}
                {selected.adLabel ? <span className="font-normal text-[#8e24aa]">・資料「{selected.adLabel}」</span> : null}
                {selected.adSource === "sent" ? <span className="font-normal text-[#8e24aa]">・送付の記録</span> : null}
              </span>
              <span>資料 {selected.materials.length}枚{selected.materialText ? "＋文字" : ""}</span>
              {selected.link && <a href={selected.link} target="_blank" rel="noreferrer" className="text-[#1565c0] underline">お客様のリンク</a>}
            </div>
          )}
          {alts.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              <span className="text-[10px] text-[#90a4ae]">選び直す:</span>
              {alts.slice(0, 10).map((t, i) => (
                <button key={`${t.name}-${t.room}-${i}`} onClick={() => onSelect(t)}
                  className="rounded-full border border-[#b0bec5] bg-white px-2 py-0.5 text-[10px] text-[#455a64] active:bg-[#eceff1]">
                  {roomLabel(t)}
                </button>
              ))}
            </div>
          )}
        </div>

        {c.warnings.length > 0 && (
          <ul className="rounded-xl bg-[#fff8e1] px-2.5 py-1.5 text-[11px] text-[#8d6e63]">
            {c.warnings.map((x, i) => <li key={i}>⚠ {x}</li>)}
            {w.conflicts.map((x, i) => <li key={`c${i}`}>⚠ {x}</li>)}
          </ul>
        )}

        {w.brain && (w.brain.action || w.brain.note) && (
          <div>
            <span className="font-bold text-[#7c3aed]">🧠 ブレイン:</span> {w.brain.action ? `AIX【${AIX_LABEL[w.brain.action] ?? w.brain.action}】` : "AIX なし"}
            {w.brain.replyDirection ? `／返信「${w.brain.replyDirection}」` : ""}
            {w.brain.note && <div className="mt-0.5 text-[10px] text-[#78909c] line-clamp-2">{w.brain.note}</div>}
          </div>
        )}
        {w.entry.show && <div className="text-[10px] text-[#00796b]">🧾 {w.entry.reason}</div>}
        {w.lowInitialCost && <div className="text-[10px] text-[#00796b]">💡 初期費用を抑えたいお客様</div>}

        <details>
          <summary className="cursor-pointer text-[11px] font-bold text-[#546e7a]">最近のお客様の発言・送った物</summary>
          <div className="mt-1 flex flex-col gap-0.5">
            {w.latestCustomer.map((m, i) => <div key={i}><span className="text-[#90a4ae]">{md(m.at)}</span> 客「{m.text}」</div>)}
            {w.sent.map((s, i) => <div key={`s${i}`}><span className="text-[#90a4ae]">{md(s.at)}</span> 送 AIX【{s.label}】</div>)}
            {w.moveIn && <div><span className="text-[#90a4ae]">入居時期（条件）</span> {w.moveIn}</div>}
            {w.summary && <div className="text-[10px] text-[#78909c] whitespace-pre-wrap">{w.summary}</div>}
          </div>
        </details>
      </div>
    </section>
  );
}
