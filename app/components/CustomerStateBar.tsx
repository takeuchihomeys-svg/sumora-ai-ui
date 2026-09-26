"use client";
// app/components/CustomerStateBar.tsx — トークの上の「今の状況」1行と、押すと開く中身（段2・2026-09-26）
//   竹内「LINE のトークの上に今の状況を把握しているステータスのような物が表示されていたら、ズレがあった際にわかりやすい。
//         物件検索や提案中の部分もステータスを細分化するイメージ」
//   - 値は GET /api/customer-state?view=compact（resolveCustomerState の結果・LLM を呼ばない・DB を読むだけ）
//   - 会話を開いた時に1回、送信・AIX・お客様の発言・状態の変更（refreshKey が変わる）で少し待って取り直す
//   - 失敗しても画面は落とさない（何も出さないだけ）
//   - ⚠ずれ は conflicts の warn（スタッフが直す食い違い）がある時だけ。直す操作は付けない（見て気づくための表示）
//   ⚠ 画面の部品なので customer-state.ts からは型だけ import する（関数を持ち込むと中の依存ごと画面の束に入る）。
//     サーバー専用（customer-state-server.ts・supabase 等）は絶対に import しない（本番ビルドだけ落ちる）
import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomerStateView, RoomEventKind, SearchingMark } from "../lib/customer-state";

const EVENT_LABEL: Record<RoomEventKind, string> = {
  sent: "送付",
  customer_shared: "お客様が共有",
  customer_mentioned: "お客様が名指し",
  check_available: "確認:募集中",
  check_vacating: "確認:退去予定",
  check_unavailable: "確認:終了",
  estimate: "見積",
  viewing_scheduled: "内覧予定",
  viewing_done: "内覧済",
  viewing_unconfirmed: "内覧日経過",
  viewing_cancelled: "内覧キャンセル",
  application: "申込",
};

const SEARCHING_LABEL: Record<NonNullable<SearchingMark["reason"]>, string> = {
  pickup_promised: "物件を探してお送りする約束が未送付",
  watch_promised: "新着が出たらお送りする約束",
  sent_after_focus: "見積・内覧などの後に別の物件も送っている",
};

const ROOM_STATUS_TONE: Record<string, string> = {
  candidate: "bg-[#f0f2f5] text-[#54656f]",
  checking: "bg-[#f0f2f5] text-[#54656f]",
  available: "bg-emerald-50 text-emerald-700",
  estimate_sent: "bg-sky-50 text-sky-700",
  viewing_scheduled: "bg-indigo-50 text-indigo-700",
  viewing_unconfirmed: "bg-amber-50 text-amber-800",
  viewed: "bg-indigo-50 text-indigo-700",
  applying: "bg-rose-50 text-rose-700",
  ended: "bg-[#f0f2f5] text-[#8696a0] line-through",
};

/** 会話の状態（conversations.status）の日本語。画面のステータスの区分と旧キー（審査管理の同期が書く viewing 等）も */
const STATUS_JA: Record<string, string> = {
  hearing: "初回対応", first_reply: "初回対応", condition_hearing: "条件ヒアリング", property_search: "物件検索",
  property_recommendation: "物件提案", proposing: "物件提案中", viewing: "内覧（審査管理の同期）", estimate_request: "見積依頼",
  availability_check: "空室確認", applying: "申込・審査中", application: "申込", screening: "審査中", contract: "契約",
  closed_won: "ご成約", closed_lost: "失注",
};

/** ISO → JST の「9/26」 */
function jstMd(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

type Props = {
  conversationId: string;
  /** 変わったら取り直す。形は「最後のメッセージのid:状態」（id が空＝まだ読み込んでいない） */
  refreshKey: string;
  authHeader: Record<string, string>;
};

export default function CustomerStateBar({ conversationId, refreshKey, authHeader }: Props) {
  const [state, setState] = useState<CustomerStateView | null>(null);
  const [stateFor, setStateFor] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const authRef = useRef(authHeader);
  authRef.current = authHeader;
  const stateForRef = useRef(stateFor);
  stateForRef.current = stateFor;

  const load = useCallback(async (cid: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const r = await fetch(`/api/customer-state?conversation_id=${encodeURIComponent(cid)}&view=compact`, { headers: authRef.current, signal: ac.signal, cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { ok?: boolean; state?: CustomerStateView };
      if (ac.signal.aborted) return;
      if (j.ok && j.state && typeof j.state.headline === "string") {
        setState(j.state);
        setStateFor(cid);
      } else {
        setState(null);
        setStateFor(cid);
      }
    } catch {
      if (ac.signal.aborted) return;
      // 失敗は出さないだけ（前の会話の値を残さない）
      setState((prev) => (stateForRef.current === cid ? prev : null));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  // 会話が変わった時: すぐ取る（前の会話の値はすぐ消す）
  useEffect(() => {
    setOpen(false);
    setShowInfo(false);
    if (!conversationId) { setState(null); setStateFor(""); return; }
    if (stateForRef.current !== conversationId) setState(null);
    void load(conversationId);
    return () => abortRef.current?.abort();
  }, [conversationId, load]);

  // 同じ会話で送信・AIX・お客様の発言・状態の変更があった時: 少し待って取り直す（送信直後の記録が DB に届くのを待つ・連続した変化は1回に畳む）
  const firstKeyRef = useRef<{ cid: string; key: string } | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    const prev = firstKeyRef.current;
    firstKeyRef.current = { cid: conversationId, key: refreshKey };
    if (!prev || prev.cid !== conversationId || prev.key === refreshKey) return;
    // 開いた直後にメッセージが読み込まれただけ（前の合図の最後のメッセージが空）は取り直さない（開いた時の1回で DB の値は取れている）
    if (prev.key.startsWith(":")) return;
    const t = setTimeout(() => { void load(conversationId); }, 2500);
    return () => clearTimeout(t);
  }, [conversationId, refreshKey, load]);

  if (!conversationId || !state || stateFor !== conversationId || !state.headline) return null;

  const warns = state.conflicts.filter((c) => c.severity === "warn");
  const infos = state.conflicts.filter((c) => c.severity === "info");
  // headline の末尾の「 ⚠ずれ」は押せる印として別に出す
  const line = state.headline.replace(/\s*⚠ずれ\s*$/, "");
  const stageEnd = line.indexOf(state.stageLabel);
  const head = stageEnd >= 0 ? line.slice(0, stageEnd + state.stageLabel.length) : line;
  const rest = stageEnd >= 0 ? line.slice(stageEnd + state.stageLabel.length) : "";
  // 内覧の日時は下の「内覧」の行で出すので、段階の一言が同じ日時だけなら繰り返さない
  const stageDetail = state.stageDetail && !(state.upcomingViewing && state.stageDetail === state.upcomingViewing.label) ? state.stageDetail : null;

  return (
    <div data-customer-state-bar="" className="border-b border-[#e9edef] bg-white/90 px-3 py-[3px] backdrop-blur-md md:px-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left active:opacity-60"
          title={line}
          aria-expanded={open}
        >
          {/* 閉じている時は1行で省略、開いた時は全体を折り返して見せる */}
          <span className={`min-w-0 flex-1 text-[11.5px] leading-[18px] text-[#3b4a54] ${open ? "break-words" : "truncate"}`}>
            <span className="font-bold text-[#111b21]">{head}</span>
            {rest}
          </span>
          <span className="shrink-0 text-[10px] text-[#8696a0]">{open ? "▲" : "▾"}</span>
        </button>
        {warns.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex h-[18px] shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full bg-amber-100 px-1.5 text-[10px] font-bold leading-none text-amber-800 active:opacity-60"
            title={warns.map((w) => w.detail).join("\n")}
          >
            ⚠ずれ
          </button>
        )}
      </div>

      {open && (
        <div className="mt-1 max-h-[55vh] space-y-2 overflow-y-auto overflow-x-hidden pb-1.5 text-[11.5px] leading-snug text-[#3b4a54]">
          {warns.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5">
              <div className="mb-0.5 text-[11px] font-bold text-amber-800">⚠ ずれ（記録どうしが食い違っています）</div>
              <ul className="list-disc space-y-0.5 pl-4 text-amber-900">
                {warns.map((w, i) => (<li key={i} className="break-words">{w.detail}</li>))}
              </ul>
            </div>
          )}

          <div className="space-y-0.5">
            {(state.since || stageDetail) && (
              <div className="break-words">
                <span className="text-[#8696a0]">{state.stageLabel} </span>
                {state.since && <span>{jstMd(state.since)}〜</span>}
                {stageDetail && <span>{state.since ? "・" : ""}{stageDetail}</span>}
              </div>
            )}
            {state.upcomingViewing && (
              <div className="break-words">
                <span className="text-[#8696a0]">内覧 </span>
                {state.upcomingViewing.label} {state.upcomingViewing.name ?? "（物件名が記録に無い）"}
                {state.upcomingViewing.inferred && <span className="text-[#8696a0]">（推定）</span>}
              </div>
            )}
            {state.searching.active && state.searching.reason && (
              <div className="break-words">
                <span className="text-[#8696a0]">探し中 </span>
                {SEARCHING_LABEL[state.searching.reason]}
                {state.searching.since && <span className="text-[#8696a0]">（{jstMd(state.searching.since)}〜）</span>}
              </div>
            )}
          </div>

          {state.properties.length > 0 && (
            <div>
              <div className="mb-0.5 text-[11px] font-bold text-[#54656f]">お部屋ごと</div>
              <ul className="divide-y divide-[#f0f2f5] rounded-lg border border-[#e9edef] bg-white">
                {state.properties.map((p) => {
                  const flags: string[] = [];
                  if (p.estimateSent && p.status !== "estimate_sent") flags.push("見積済");
                  if (p.vacating) flags.push("退去予定");
                  if (p.customerInterest) flags.push("お客様が指名");
                  if (!p.sentByUs) flags.push("お客様の持ち込み");
                  return (
                    <li key={p.key} className="px-2 py-1">
                      <div className="flex min-w-0 items-start gap-1">
                        <span className="min-w-0 flex-1 break-words font-semibold text-[#111b21]">
                          {p.key === state.focusKey && <span className="text-amber-500">★</span>}
                          {p.name}
                        </span>
                        <span className={`shrink-0 whitespace-nowrap rounded px-1 text-[10px] font-bold leading-[16px] ${ROOM_STATUS_TONE[p.status] ?? ROOM_STATUS_TONE.candidate}`}>{p.statusLabel}</span>
                      </div>
                      {flags.length > 0 && <div className="text-[10.5px] text-[#54656f]">{flags.join("・")}</div>}
                      {p.maybeSameAs.length > 0 && (
                        <div className="break-words text-[10.5px] text-amber-800">未確認: {p.maybeSameAs.slice(0, 2).join("／")} と同じ？</div>
                      )}
                      {p.events.length > 0 && (
                        <div className="break-words text-[10.5px] text-[#8696a0]">
                          {p.events.map((e) => `${jstMd(e.at)} ${EVENT_LABEL[e.kind] ?? e.kind}`).join(" · ")}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {(state.candidateCount > 0 || state.hiddenNotable > 0) && (
                <div className="mt-0.5 text-[10.5px] text-[#8696a0]">
                  {state.hiddenNotable > 0 ? `ほかに進んだお部屋 ${state.hiddenNotable}件` : ""}
                  {state.hiddenNotable > 0 && state.candidateCount > 0 ? "・" : ""}
                  {state.candidateCount > 0 ? `ほかに送っただけの候補 ${state.candidateCount}件` : ""}
                </div>
              )}
            </div>
          )}

          {infos.length > 0 && (
            <div>
              <button type="button" onClick={() => setShowInfo((v) => !v)} className="text-[10.5px] text-[#8696a0] active:opacity-60">
                {showInfo ? "▲" : "▾"} 参考（読む側で吸収済みの食い違い {infos.length}件）
              </button>
              {showInfo && (
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[10.5px] text-[#667781]">
                  {infos.map((c, i) => (<li key={i} className="break-words">{c.detail}</li>))}
                </ul>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 text-[10px] text-[#8696a0]">
            <span className="min-w-0 break-words">材料: 状態＝{state.statusRaw ? (STATUS_JA[state.statusRaw] ?? state.statusRaw) : "未設定"}{state.brainPhase ? `／ブレインの段階＝${STATUS_JA[state.brainPhase] ?? state.brainPhase}` : ""}</span>
            <button type="button" onClick={() => void load(conversationId)} disabled={loading} className="shrink-0 rounded-full border border-[#d1d7db] px-1.5 py-[1px] active:opacity-60">
              {loading ? "…" : "↻ 取り直す"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
