"use client";
// ITANDI の「まとめて図面取得」の ZIP（または中の PDF・JPEG）を入れると、物件ごとに1ページ目を弊社の帯に帯替えした画像にして、
// AIX【物件ピックアップした】の物件画像に足す（足した後は今の物件画像と同じ流れ＝送ると画像の読み取り・送付の記録）。
// 2026-10-06 竹内「まとめて図面ダウンロードをおして保存されるPDFをそのままAIXツールのところに入れて解析はできるのか」
//   「帯替えとはこのように弊社の情報に帯を変更するということ　帯の部分だけ判断して変えれば良い」
// 帯替えできなかった物（画像の図面・業者向けの案内・帯の境目が分からない）は足さず、理由を出す。
// 画像の図面は、スタッフが目で見て元付の情報が無いと確かめた時だけ「そのまま入れる」で足せる。
import { useRef, useState } from "react";
import type { ZumenItem } from "../lib/zumen-obi-browser";

export default function ZumenZipImport({ onAdd }: { onAdd: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [items, setItems] = useState<ZumenItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const onSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (inputRef.current) inputRef.current.value = "";
    if (!files.length) return;
    setError(null); setItems(null); setAdded(new Set());
    setBusy({ done: 0, total: 0 });
    try {
      const { processZumenFiles } = await import("../lib/zumen-obi-browser");
      const res = await processZumenFiles(files, (done, total) => setBusy({ done, total }));
      setItems(res);
      const ok = res.filter((r) => r.status === "ok" && r.file);
      if (ok.length) {
        onAdd(ok.map((r) => r.file!));
        setAdded(new Set(ok.map((r) => r.key)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const okN = items?.filter((r) => r.status === "ok").length ?? 0;
  const stopN = items ? items.length - okN : 0;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={!!busy}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-amber-300 py-2.5 text-sm font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
        title="ITANDI の「まとめて図面取得」の ZIP（または中の PDF・JPEG）を選ぶと、物件ごとに1ページ目を弊社の帯に帯替えして物件画像に足します"
      >
        📦 {busy ? `帯替え中… ${busy.done}/${busy.total || "?"}` : "ITANDI の図面 ZIP を帯替えして入れる"}
      </button>
      <input ref={inputRef} type="file" accept=".zip,application/zip,application/pdf,.pdf,image/*" multiple onChange={onSelect} className="hidden" />
      {error && <p className="mt-1 text-xs text-red-600">読めませんでした: {error}</p>}
      {items && (
        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-[#3b4a54]">
          <div className="mb-1 font-bold">帯替えして入れた {okN}件{stopN ? `・入れていない ${stopN}件（下の理由を確かめてください）` : ""}</div>
          <ul className="flex flex-col gap-1.5">
            {items.map((it) => (
              <li key={it.key} className="leading-5">
                <span className={it.status === "ok" ? "text-emerald-700" : "text-red-700"}>{it.status === "ok" ? "✅" : "⏸"} {it.label}</span>
                {it.status === "ok" && it.previewUrl && (
                  <a href={it.previewUrl} target="_blank" rel="noreferrer" className="ml-2 text-[#2196F3] underline">帯替えした画像を見る</a>
                )}
                {it.status !== "ok" && it.reasons.map((r, i) => <div key={i} className="pl-4 text-[#54656f]">{r}</div>)}
                {it.warnings.map((w, i) => <div key={`w${i}`} className="pl-4 text-amber-700">⚠ {w}</div>)}
                {it.notes.map((n, i) => <div key={`n${i}`} className="pl-4 text-[#90a4ae]">{n}</div>)}
                {it.status !== "ok" && it.imageAsIs && !added.has(it.key) && (
                  <button
                    type="button"
                    className="ml-4 mt-0.5 rounded-full border border-[#d1d7db] bg-white px-2 py-0.5 text-[11px] text-[#54656f]"
                    onClick={() => {
                      if (!window.confirm(`「${it.label}」の画像に元付業者の情報（会社名・TEL・手数料・AD）が無い事を目で確かめましたか？\nOK でそのまま物件画像に入れます。`)) return;
                      onAdd([it.imageAsIs!]);
                      setAdded((s) => new Set(s).add(it.key));
                    }}
                  >目で確かめた・そのまま入れる</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
