"use client";
// app/components/PropertySearchFocusButton.tsx — 状態の帯（CustomerStateBar）を広げた中の「🔍 物件検索」
//
// 2026-10-06 竹内（会話「H0N0KA.」）「ここ広げたところに物件検索ボタンを出す。そうすると拡張ツール繰り上げられるようにする」
//   追加「スマホで押しても連携して拡張ツールのお客さんの一番上に繰り上がるようにする」
// 押すと:
//   ① サーバーに印（POST /api/property-search-focus・押した時刻と端末）→ どの PC の拡張でもお客様の一覧の一番上「📌 会話から物件検索」に出る
//      （拡張は開いた時・一覧の取り直し・開いている間 45秒ごとに拾う。押した後に検索・送付したら／24時間で一番上から外れる）
//   ② この端末の Chrome に拡張があれば（webapp-bridge の ACK）、リアプロ／ITANDI のタブを前に出してそのお客様を開く。
//      タブが無ければ拡張の横のパネルを開く（Chrome は押した直後しか開かせない＝postMessage はクリックの中で同期に出す）
//   検索は押さない（自動の検索は止めている・案内モードで人が ▶案内 を押す）。
//   条件の言い直しは LINE の受信で登録の条件に自動で入る（P4・ブレイン・元に戻すは帯の上）→ ここでは「条件の最後の更新」を見せるだけ
// ⚠ 画面の部品: サーバー専用のライブラリは import しない（search-focus.ts は純関数だけ）
import { useCallback, useEffect, useRef, useState } from "react";
import { conditionWriterJa, type LastConditionChange } from "../lib/search-focus";

type Info = {
  customer: { id: string; name: string | null; status: string | null } | null;
  focus: { at: string; by: string | null; device: string | null } | null;
  tableMissing?: boolean;
  lastConditionChange: LastConditionChange | null;
};

type Props = { conversationId: string; authHeader: Record<string, string> };

function jstMdHm(iso: string | null | undefined): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function shortVal(v: string | null): string {
  if (v == null || v === "") return "なし";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > 14 ? s.slice(0, 14) + "…" : s;
}

type ExtResult = { ok?: boolean; via?: string; site?: string; opened?: boolean; reason?: string | null; error?: string | null };

/** 拡張（webapp-bridge）に直接渡す。クリックの中で同期に postMessage する（パネルを開くのに「押した直後」が要る） */
function postToExtension(reqId: string, customerId: string, customerName: string, at: string): { ack: Promise<boolean>; result: Promise<ExtResult | null> } {
  let resolveAck: (v: boolean) => void = () => {};
  let resolveResult: (v: ExtResult | null) => void = () => {};
  const ack = new Promise<boolean>((r) => { resolveAck = r; });
  const result = new Promise<ExtResult | null>((r) => { resolveResult = r; });
  const onMsg = (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data as { from?: string; reqId?: string } & ExtResult;
    if (!d || d.reqId !== reqId) return;
    if (d.from === "aixlinx-webapp-search-focus-ack") resolveAck(true);
    if (d.from === "aixlinx-webapp-search-focus-result") { resolveResult(d); window.removeEventListener("message", onMsg); }
  };
  window.addEventListener("message", onMsg);
  window.postMessage({ from: "aixlinx-webapp-search-focus", reqId, customerId, customerName, at }, window.location.origin);
  setTimeout(() => resolveAck(false), 1200);
  setTimeout(() => { resolveResult(null); window.removeEventListener("message", onMsg); }, 15000);
  return { ack, result };
}

function extMessage(r: ExtResult | null): string {
  if (!r) return "拡張から返事がありません（拡張を開くと一番上に出ています）";
  if (r.reason === "batch-running") return "一括検索の最中なのでタブは動かしていません（一覧の一番上に出ています）";
  if (r.via === "tab") return `${r.site === "itandi" ? "ITANDI" : "リアプロ"}のタブを前に出しました${r.opened ? "（お客様を開いています）" : "（一番上に出ています）"}`;
  if (r.via === "panel") return "拡張のパネルを開きました（お客様を開いています）";
  if (r.reason === "panel-refused") return "Chrome がパネルを開かせませんでした。拡張のアイコンを押してください（一番上に出ています）";
  return "拡張の一覧の一番上に出ています";
}

export default function PropertySearchFocusButton({ conversationId, authHeader }: Props) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const authRef = useRef(authHeader);
  authRef.current = authHeader;

  const load = useCallback(async (cid: string, signal?: AbortSignal) => {
    try {
      const r = await fetch(`/api/property-search-focus?conversation_id=${encodeURIComponent(cid)}`, { headers: authRef.current, cache: "no-store", signal });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { ok?: boolean } & Info;
      if (signal?.aborted) return;
      setInfo(j.ok ? { customer: j.customer ?? null, focus: j.focus ?? null, tableMissing: !!j.tableMissing, lastConditionChange: j.lastConditionChange ?? null } : null);
    } catch {
      if (!signal?.aborted) setInfo(null);
    }
  }, []);

  useEffect(() => {
    setInfo(null);
    setMsg("");
    if (!conversationId) return;
    const ac = new AbortController();
    void load(conversationId, ac.signal);
    return () => ac.abort();
  }, [conversationId, load]);

  const onClick = () => {
    const c = info?.customer;
    if (!c || busy) return;
    setBusy(true);
    setMsg("");
    const at = new Date().toISOString();
    const reqId = `sf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // ② 拡張へ（同期・await より前）
    const ext = postToExtension(reqId, c.id, c.name ?? "", at);
    // ① サーバーの印
    const mark = fetch("/api/property-search-focus", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authRef.current },
      body: JSON.stringify({ conversation_id: conversationId }),
    }).then(async (r) => ({ ok: r.ok, j: (await r.json().catch(() => ({}))) as { error?: string; focus?: Info["focus"] } })).catch(() => ({ ok: false, j: { error: "network" } as { error?: string; focus?: Info["focus"] } }));

    void (async () => {
      const [m, hasExt] = await Promise.all([mark, ext.ack]);
      const markText = m.ok ? "印を付けました" : m.j.error === "table-missing" ? "印の表が本番に未作成のため、スマホからは繋がりません" : "印を付けられませんでした";
      if (m.ok && m.j.focus) setInfo((prev) => (prev ? { ...prev, focus: m.j.focus ?? prev.focus } : prev));
      if (!hasExt) {
        setMsg(`${markText}。${m.ok ? "PC の拡張のお客様の一覧の一番上に出ます" : ""}`);
        setBusy(false);
        return;
      }
      setMsg(`${markText}。拡張に渡しています…`);
      const r = await ext.result;
      setMsg(`${markText}。${extMessage(r)}`);
      setBusy(false);
    })();
  };

  if (!info) return null;
  const c = info.customer;
  const lc = info.lastConditionChange;
  const writer = lc ? conditionWriterJa(lc.writer) : "";

  return (
    <div className="rounded-lg border border-[#e9edef] bg-white px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onClick}
          disabled={!c || busy}
          className="flex h-[26px] shrink-0 items-center rounded-full bg-[#00a884] px-3 text-[11.5px] font-bold text-white active:opacity-70 disabled:bg-[#c5ccd0]"
          title="このお客様を Chrome 拡張（物件検索）のお客様の一覧の一番上に出します。この PC の Chrome に拡張があれば、リアプロ／ITANDI のタブを前に出してお客様を開きます（検索は押しません）"
        >
          {busy ? "…" : "🔍 物件検索"}
        </button>
        <span className="min-w-0 flex-1 break-words text-[10.5px] text-[#54656f]">
          {!c
            ? "物件検索のお客様に紐付いていません"
            : msg || (info.focus ? `拡張の一番上へ: ${jstMdHm(info.focus.at)} ${info.focus.device === "phone" ? "スマホ" : "PC"}で押されました` : "拡張のお客様の一番上に出します（スマホからでも）")}
        </span>
      </div>
      {c && lc && lc.fields.length > 0 && (
        <div className="mt-1 break-words text-[10.5px] text-[#8696a0]">
          条件の最後の更新 {jstMdHm(lc.at)}{writer ? `（${writer}）` : ""}: {lc.fields.slice(0, 4).map((f) => `${f.label} ${shortVal(f.old)}→${shortVal(f.new)}`).join("・")}
          {lc.fields.length > 4 ? ` ほか${lc.fields.length - 4}` : ""}
        </div>
      )}
    </div>
  );
}
