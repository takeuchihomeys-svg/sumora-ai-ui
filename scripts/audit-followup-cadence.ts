// scripts/audit-followup-cadence.ts — 追客の決め方の線を実送信で引き直す（読むだけ・LLM なし・DB は読み取りのみ）
//   2026-11-12 作業員19（統括役「追客の数え」）。brain-core の「黙って3日以上＋物件提案済み→followup_revive」「連続未返信送付2件以上は物件を探さない」と、
//   竹内さんの決定 d76e886d（追客＝AIX【物件ピックアップした】【物件オススメ】だけ・日ごとに1回・hot から外すのは3回無視）の食い違いを数字で見る。
//
//   数える物（沈黙の区間＝お客様の最後の発言から、お客様の次の発言までの間）:
//     1. 区間の中でスタッフが最初に動くまでの日数（1・2・3・4〜6・7日以上・動かず）と、その種類（物件の AIX／followup_revive／その他の AIX／手打ちのみ）
//     2. 区間の中の追客の回数（物件の AIX と followup_revive を数える）の分布と、「3回送って止めた」割合・止めた後にお客様が戻った割合
//     3. 追客の種類ごと・間隔ごと（直前の追客から 1・2・3・4〜6・7日以上）に、24時間以内にお客様が返した割合
//     4. 直前のお客様の保留の型（また連絡します／少し待って／検討します／入居が先／その他）ごとの 1〜3
//     5. ブレイン側: brain_decision_logs で followup_revive を出した番の数と、その後72時間にスタッフが押した AIX が同じ種類か
//
//   実行: 営業時間（JST 9〜22時）は DB の全件読みを避ける（memory feedback_no_heavy_db_business_hours）。22時以降に流す。
//     npx tsx --env-file=.env.local scripts/audit-followup-cadence.ts [--days=180] [--limit=400] [--force]
//   --force なしでは JST 9〜22時は動かず終わる。YUMA 系・グループ（line_user_id が C で始まる）は除く。個人の文は出さない（件数だけ）。
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const DAYS = Number(arg("days", "180"));
const LIMIT = Number(arg("limit", "400"));
const FORCE = process.argv.includes("--force");
const DAY = 86_400_000;

const jstHour = (new Date(Date.now() + 9 * 3600_000)).getUTCHours();
if (!FORCE && jstHour >= 9 && jstHour < 22) {
  console.log(`今は JST ${jstHour}時（営業時間）。22時以降に流してください（--force で上書き）。何も読んでいません。`);
  process.exit(0);
}

type Msg = { sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
type Aix = { aix_type: string | null; sent_at: string | null; created_at: string };

const PROPERTY_AIX = new Set(["property_send", "property_recommendation"]);
const HOLD_TYPES: Array<[string, RegExp]> = [
  ["また連絡します", /また連絡|連絡します|後で(連絡|送)|あとで/],
  ["少し待って", /少し待って|待ってください|お待ちください|保留/],
  ["検討します", /検討|考えさせて|考え中|迷って|悩んで/],
  ["入居が先", /(来月|再来月|[0-9０-９]+月|年明け|来年).{0,8}(入居|引っ越|引越)|まだ(先|急がない)/],
];
const holdTypeOf = (t: string | null) => { const s = String(t ?? ""); for (const [k, re] of HOLD_TYPES) if (re.test(s)) return k; return "その他"; };
const bucket = (days: number) => (days < 1.5 ? "1日" : days < 2.5 ? "2日" : days < 3.5 ? "3日" : days < 7 ? "4〜6日" : "7日以上");
const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%（${a}/${b}）` : "—");

(async () => {
  const since = new Date(Date.now() - DAYS * DAY).toISOString();
  // 会話の一覧（直近で動きのあった物・グループとテスト用は除く）
  const { data: convsRaw, error } = await sb.from("conversations").select("id, line_user_id").gte("updated_at", since).order("updated_at", { ascending: false }).limit(LIMIT);
  if (error) { console.log("conversations 読めず:", error.message); process.exit(1); }
  const convs = (convsRaw ?? []).filter((c) => !isTestConversation(c.id as string) && !String(c.line_user_id ?? "").startsWith("C"));
  console.log(`会話 ${convs.length}（${DAYS}日・上限 ${LIMIT}・グループとテスト用を除く）`);

  const first: Record<string, number> = {};      // 1. 最初に動くまでの日数×種類
  const firstKind: Record<string, number> = {};
  const countDist: Record<string, number> = {};  // 2. 追客の回数の分布
  let stoppedAt3 = 0, stoppedAt3Returned = 0, segments = 0;
  const reply24: Record<string, { sent: number; replied: number }> = {}; // 3. 種類×間隔
  const byHold: Record<string, { seg: number; chase: number; replied24: number }> = {}; // 4. 保留の型

  for (const c of convs) {
    const cid = c.id as string;
    const { data: ms } = await sb.from("messages").select("sender, created_at, text, is_aix_generated").eq("conversation_id", cid).gte("created_at", since).order("created_at").limit(4000);
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", cid).gte("created_at", since);
    const list = (ms ?? []) as Msg[];
    const aix = ((ax ?? []) as Aix[]).map((a) => ({ type: a.aix_type ?? "", at: Date.parse(a.sent_at ?? a.created_at) })).sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer") continue;
      if (list[i + 1] && list[i + 1].sender === "customer") continue; // 連投の最後だけ
      const lastCust = list[i];
      const t0 = Date.parse(lastCust.created_at);
      const nextCustIdx = list.findIndex((m, j) => j > i && m.sender === "customer");
      const tEnd = nextCustIdx >= 0 ? Date.parse(list[nextCustIdx].created_at) : Infinity;
      // 区間の中のスタッフの動き（お客様に届いた物だけ）
      const staff = list.filter((m, j) => j > i && m.sender !== "customer" && Date.parse(m.created_at) < tEnd && (m.text ?? "").trim() && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/.test(m.text ?? ""));
      const aixIn = aix.filter((a) => a.at > t0 && a.at < tEnd);
      // 区間の長さが2日未満で次のお客様の発言がある普通のやり取りは、追客の区間ではない（最初のスタッフの動きが遅い時だけ数える）
      const firstStaffAt = staff.length ? Date.parse(staff[0].created_at) : Infinity;
      const firstAixAt = aixIn.length ? aixIn[0].at : Infinity;
      const firstAt = Math.min(firstStaffAt, firstAixAt);
      const quiet = (Number.isFinite(tEnd) ? tEnd : Date.now()) - t0;
      if (quiet < 2 * DAY) continue; // 2日以上のお客様の沈黙だけを区間に数える
      segments++;
      const hold = holdTypeOf(lastCust.text);
      byHold[hold] ??= { seg: 0, chase: 0, replied24: 0 }; byHold[hold].seg++;
      // 1. 最初に動くまで
      if (!Number.isFinite(firstAt)) inc(first, "動かず");
      else {
        inc(first, bucket((firstAt - t0) / DAY));
        const aixAtFirst = aixIn.find((a) => a.at === firstAt);
        inc(firstKind, aixAtFirst ? (PROPERTY_AIX.has(aixAtFirst.type) ? "物件の AIX" : aixAtFirst.type === "followup_revive" ? "followup_revive" : "その他の AIX") : "手打ちのみ");
      }
      // 2・3. 追客（物件の AIX と followup_revive）の回数と、その後24時間のお客様の返事
      const chases = aixIn.filter((a) => PROPERTY_AIX.has(a.type) || a.type === "followup_revive");
      inc(countDist, chases.length >= 4 ? "4回以上" : `${chases.length}回`);
      byHold[hold].chase += chases.length;
      let prev = t0;
      for (const ch of chases) {
        const gapB = bucket((ch.at - prev) / DAY);
        const kind = ch.type === "followup_revive" ? "followup_revive" : "物件の AIX";
        const key = `${kind}｜直前から${gapB}`;
        reply24[key] ??= { sent: 0, replied: 0 }; reply24[key].sent++;
        const replied = list.some((m) => m.sender === "customer" && Date.parse(m.created_at) > ch.at && Date.parse(m.created_at) <= ch.at + DAY);
        if (replied) { reply24[key].replied++; byHold[hold].replied24++; }
        prev = ch.at;
      }
      if (chases.length === 3) {
        stoppedAt3++;
        if (nextCustIdx >= 0 && tEnd - chases[2].at < 14 * DAY) stoppedAt3Returned++; // 3回目の後14日以内にお客様が戻った
      }
    }
  }
  console.log(`\n沈黙の区間（お客様が2日以上黙った区間）: ${segments}`);
  console.log("1. 最初にスタッフが動くまで:", JSON.stringify(first));
  console.log("   最初の動きの種類:", JSON.stringify(firstKind));
  console.log("2. 追客の回数の分布:", JSON.stringify(countDist), `／3回で止めた区間 ${stoppedAt3}・14日以内に戻った ${pct(stoppedAt3Returned, stoppedAt3)}`);
  console.log("3. 追客の種類×間隔ごとの24時間以内の返事:");
  for (const k of Object.keys(reply24).sort()) console.log(`   ${k}: ${pct(reply24[k].replied, reply24[k].sent)}`);
  console.log("4. 直前のお客様の保留の型ごと（区間・追客の数・追客後24時間の返事）:");
  for (const [k, v] of Object.entries(byHold)) console.log(`   ${k}: 区間 ${v.seg}・追客 ${v.chase}・返事 ${pct(v.replied24, v.chase)}`);

  // 5. ブレイン側（followup_revive を出した番と、その後72時間のスタッフの AIX）
  const { data: logs } = await sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action").eq("suggested_action", "followup_revive").gte("created_at", since).order("created_at", { ascending: false }).limit(1500);
  const rows = (logs ?? []).filter((l) => !isTestConversation(l.conversation_id as string));
  let same = 0, other = 0, none = 0;
  const seen = new Set<string>();
  for (const l of rows) {
    const k = `${l.conversation_id}:${String(l.created_at).slice(0, 10)}`;
    if (seen.has(k)) continue; seen.add(k);
    const at = Date.parse(l.created_at as string);
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", l.conversation_id as string).gte("created_at", new Date(at).toISOString()).lte("created_at", new Date(at + 3 * DAY).toISOString()).order("created_at").limit(3);
    const first1 = ((ax ?? []) as Aix[])[0]?.aix_type ?? null;
    if (!first1) none++; else if (first1 === "followup_revive") same++; else other++;
  }
  console.log(`5. ブレインの followup_revive（日ごと・会話ごと ${seen.size}）→ 72時間以内にスタッフが押した AIX: 同じ ${same}・別 ${other}・押さず ${none}`);
  console.log("\n読み方: 竹内さんの追客は物件の AIX が主で3回で止める（d76e886d）なら、1・2 で物件の AIX が多く、回数の山が3回。followup_revive の返事率が物件の AIX より低い・5 の『押さず』が多いなら、followup_revive の決め打ち（3日黙る）を外す根拠になる。");
})();
