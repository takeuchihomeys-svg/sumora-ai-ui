// 主のお部屋（customer-state の focusKey）が「古い出来事」に引っ張られていないかを実会話で読む（読み取りのみ・LLM なし）
// 2026-09-27 竹内（YUMA の実送信直後に「📨 提案中 コンフォリア・リヴ北久宝寺Q｜内覧日経過(未確認) 他4件」＝7/5 の持ち込みが主）
//   で FOCUS_FRESH_DAYS（21日）を入れた時の前後比較の道具。順位だけで選んだ場合（旧）と今の主を並べ、違う会話を全部出す。
//   2026-09-27 の結果（直近40日・211会話）: 変わった31件。主が変わったのは9件（「提案中」で古い見積・内覧済（7/23〜9/02）→ その後の送付 が8件・8/22 内覧済→9/22 見積済 が1件）。
//   残りは「他N件」から古いお部屋が外れただけ（他18件→3件 等）。14日にすると 9/09 内覧済→9/18 送付 のように内覧直後に探し続けている会話まで主が候補に倒れるので21日。
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-state-focus.ts   （DAYS=40 N=400）
import { createClient } from "@supabase/supabase-js";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { resolveCustomerState, isStaleRoom, FOCUS_FRESH_DAYS, type RoomState } from "../app/lib/customer-state";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const RANK: Record<string, number> = { candidate: 0, checking: 1, available: 2, estimate_sent: 3, viewing_scheduled: 4, viewing_unconfirmed: 4.5, viewed: 5, applying: 6, ended: -1 };

async function main() {
  const since = new Date(Date.now() - Number(process.env.DAYS ?? 40) * 864e5).toISOString();
  const { data: convs, error } = await sb.from("conversations").select("id, line_source_type, updated_at").gte("updated_at", since).order("updated_at", { ascending: false }).limit(Number(process.env.N ?? 400));
  if (error) throw new Error(error.message);
  let n = 0, changed = 0;
  const now = Date.now();
  for (const c of convs ?? []) {
    if (c.id === YUMA || c.line_source_type === "group") continue;
    const input = await loadCustomerStateInput(c.id).catch(() => null);
    if (!input) continue;
    n++;
    const s = resolveCustomerState(input);
    // 旧（順位だけ）: 進んだお部屋を順位→新しさで
    const legacy = s.properties.filter((p) => p.status !== "ended" && (RANK[p.status] >= RANK.available || p.customerInterest))
      .sort((a, b) => RANK[b.status] - RANK[a.status] || Date.parse(b.lastAt) - Date.parse(a.lastAt))[0] as RoomState | undefined;
    const focus = s.properties.find((p) => p.key === s.focusKey);
    if (!legacy || !focus || legacy.key === focus.key) continue;
    changed++;
    console.log(`${c.id.slice(0, 8)} ${s.stageLabel}\n  順位だけ: ${legacy.name}（${legacy.statusLabel}・${legacy.lastAt.slice(0, 10)}${isStaleRoom(legacy, now) ? "・古い" : ""}）\n  今の主  : ${focus.name}（${focus.statusLabel}・${focus.lastAt.slice(0, 10)}）\n  1行     : ${s.headline}`);
  }
  console.log(`\n会話 ${n} 件・主が順位だけの選び方と違う ${changed} 件（FOCUS_FRESH_DAYS=${FOCUS_FRESH_DAYS}）`);
}
main();
