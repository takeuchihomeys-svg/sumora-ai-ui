"use client";
// app/components/TopBandsFold.tsx — 会話画面の上の帯（約束【必ず】・メモ・日付の無い約束・お客様の確認事項・約束の続き・申込30日の確認）を
//   既定は「小さな札を並べた1行」にたたみ、押したら全部を展開する入れ物（画面だけ・データも判定も変えない）。
//   2026-10-13 竹内さん「メモや約束した事はツールに折りたたんで隠す。画面に出すぎていて目が疲れる…通知があれば押したら展開する形にすれば見やすい」
//   ・展開は会話ごとに覚えない（会話を変えたら毎回たたむ＝resetKey）
//   ・中の帯は今まで通り描く（各帯の取り直し・判定はそのまま）。たたんでいる間は display:none で隠すだけ＝札は「中身がある帯」だけ出す
//   ・札の数と色は帯の側の目印で決める（FoldSlot の count/tone/urgent か、帯の一番外の要素の data-fold-count / data-fold-tone / data-fold-urgent）
//   ・急ぎ（urgent: 申込30日の確認・期日を過ぎた【必ず】の約束）だけ札を赤地で目立たせる＝たたんでも見落とさない（設計知見 a9fc9ec8「届く場所」）
//   戻す: NEXT_PUBLIC_TOP_BANDS_FOLD=off（今まで通り全部むき出し）
// ⚠ サーバー専用ライブラリを import しない（本番のビルドだけ落ちる）
import { useEffect, useRef, useState, type ReactNode } from "react";

type Tone = "red" | "blue" | "gray";
type Chip = { key: string; label: string; count: number | null; tone: Tone; urgent: boolean };

/** 帯1つ分の枠（中身が空なら札を出さない） */
export function FoldSlot({ id, label, count, tone, urgent, children }: { id: string; label: string; count?: number | null; tone?: Tone; urgent?: boolean; children?: ReactNode }) {
  return (
    <div data-fold-slot={id} data-fold-label={label} data-fold-count={count ?? undefined} data-fold-tone={tone ?? undefined} data-fold-urgent={urgent ? "1" : undefined}>
      {children}
    </div>
  );
}

function readChips(root: HTMLElement): Chip[] {
  const out: Chip[] = [];
  root.querySelectorAll<HTMLElement>(":scope > [data-fold-slot]").forEach((el) => {
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return; // 中身なし（帯が何も描いていない）
    const pick = (k: "foldCount" | "foldTone" | "foldUrgent") => el.dataset[k] ?? inner.dataset[k];
    const c = pick("foldCount");
    const n = c != null && c !== "" && Number.isFinite(Number(c)) ? Number(c) : null;
    if (n === 0 && pick("foldUrgent") !== "1") return; // 数が 0 の帯は札にしない
    const tone = (pick("foldTone") as Tone | undefined) ?? "gray";
    // 札の文字は帯の側（data-fold-label・例「条件の更新 10/12 22:41」）があればそれ、無ければ枠の label
    out.push({ key: el.dataset.foldSlot ?? "", label: inner.dataset.foldLabel ?? el.dataset.foldLabel ?? "", count: n, tone, urgent: pick("foldUrgent") === "1" });
  });
  return out;
}

export default function TopBandsFold({ resetKey, children }: { resetKey: string; children?: ReactNode }) {
  const off = (process.env.NEXT_PUBLIC_TOP_BANDS_FOLD ?? "").toLowerCase() === "off";
  const [open, setOpen] = useState(false);
  const [chips, setChips] = useState<Chip[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 会話を変えたら毎回たたむ（展開は覚えない）
  useEffect(() => { setOpen(false); }, [resetKey]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const sync = () => {
      const next = readChips(root);
      setChips((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-fold-count", "data-fold-tone", "data-fold-urgent", "data-fold-label"] });
    return () => mo.disconnect();
  }, []);

  if (off) return <>{children}</>;
  const anyUrgent = chips.some((c) => c.urgent);
  return (
    <>
      {chips.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`flex w-full items-center gap-1.5 overflow-x-auto whitespace-nowrap border-b px-3 py-1 text-left active:opacity-70 md:px-4 ${anyUrgent ? "border-[#ef9a9a] bg-[#fff5f5]" : "border-[#e9edef] bg-[#f7f8fa]"}`}
          style={{ scrollbarWidth: "none" }}
        >
          {chips.map((c) => (
            <span
              key={c.key}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[1px] text-[10px] font-bold leading-[16px] ${
                c.urgent ? "bg-[#d32f2f] text-white" : "border border-[#d1d7db] bg-white text-[#54656f]"
              }`}
            >
              {c.label}
              {c.count != null && (
                <span className={c.urgent ? "text-white" : c.tone === "red" ? "text-[#d32f2f]" : c.tone === "blue" ? "text-[#3949ab]" : "text-[#8696a0]"}>{c.count}</span>
              )}
            </span>
          ))}
          <span className="ml-auto shrink-0 pl-1 text-[10px] font-bold text-[#8696a0]">{open ? "▲ たたむ" : "▼ 開く"}</span>
        </button>
      )}
      <div ref={bodyRef} style={open ? undefined : { display: "none" }}>
        {children}
      </div>
    </>
  );
}
