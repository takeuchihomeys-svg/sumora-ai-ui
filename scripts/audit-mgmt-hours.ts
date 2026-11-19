// scripts/audit-mgmt-hours.ts — 管理会社の定休日・祝日の営業・夜の確認の線を、実際の LINE から数える（読むだけ・LLM なし・DB は読み取りのみ）
//   2026-11-12 作業員19（統括役「竹内さんに聞く前に実際の LINE から読み取る」）。time-facts.ts の「休みの扱い」（土日祝）と営業の線（電話19・管理会社18・弊社21）を実際の線に直す材料。
//
//   数える物（申込以降の会話は外す＝申込の門・名前は出さず件数だけ）:
//     ① スタッフの送信で「管理会社がお休み・定休日・営業時間外・明日確認・営業開始次第」等の言い方を、送った曜日・祝日・時刻ごとに（言い方の種類は 休み／定休／営業時間外／明日／営業開始／本日中）
//     ② 確認の約束（「確認させて頂きます」系）を送ってから、結果の AIX（物件確認した＝property_check_result・確認した）を送るまでの時間を、約束を送った曜日・時刻・祝日ごとに／
//        line_tasks（task_type=property_check）の created_at→resolved_at（管理会社から答えが返った記録）を、答えが記録された曜日・時刻ごとに
//     ③ 電話・弊社の営業の終わり: 「電話」「お電話」「営業時間」を含むスタッフの送信の時刻と、スタッフの送信（全部）の時刻の分布で営業の終わり（19時・21時）の実際を見る
//     ④ 管理会社ごとの違い: sent_properties に管理会社の列があれば会社ごとに曜日の答えの割合（会社名は出さず 会社A・B… の件数だけ・5件未満は出さない）
//   読み方: 曜日×時刻の表に「答えが記録された件数」が土日祝にあるか（水曜など定休日の線が出るか）を見る。
//
//   実行: 営業時間（JST 9〜22時）は DB の全件読みを避ける（memory feedback_no_heavy_db_business_hours）。22時以降に流す。
//     npx tsx --env-file=.env.local scripts/audit-mgmt-hours.ts [--days=180] [--force]
//   --force なしでは JST 9〜22時は何も読まず終わる。YUMA 系・グループ（line_user_id が C で始まる）・申込以降は除く。お客様の文・名前は出さない。
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
import { JP_HOLIDAYS } from "../app/lib/business-clock";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const DAYS = Number(arg("days", "180"));
const FORCE = process.argv.includes("--force");
const jstHourNow = new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (!FORCE && jstHourNow >= 9 && jstHourNow < 22) {
  console.log(`今は JST ${jstHourNow}時（営業時間）。22時以降に流してください（--force で上書き）。何も読んでいません。`);
  process.exit(0);
}

const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const jst = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); const ymd = d.toISOString().slice(0, 10); return { ymd, dow: d.getUTCDay(), hour: d.getUTCHours(), holiday: !!JP_HOLIDAYS[ymd] }; };
const dayKind = (iso: string) => { const j = jst(iso); return j.holiday ? "祝" : DOW[j.dow]; };
const hourBand = (h: number) => (h < 9 ? "〜9時" : h < 12 ? "9〜12時" : h < 15 ? "12〜15時" : h < 18 ? "15〜18時" : h < 19 ? "18時台" : h < 21 ? "19〜21時" : "21時〜");
const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const table = (o: Record<string, number>, order: string[]) => order.map((k) => `${k}:${o[k] ?? 0}`).join(" ");
const DAY_ORDER = ["月", "火", "水", "木", "金", "土", "日", "祝"];
const BAND_ORDER = ["〜9時", "9〜12時", "12〜15時", "15〜18時", "18時台", "19〜21時", "21時〜"];

const CLOSED_PHRASES: Array<[string, RegExp]> = [
  ["休み", /お休み|休業|休暇/],
  ["定休", /定休/],
  ["営業時間外", /営業時間外|営業時間が終了|営業時間終了|営業終了/],
  ["明日確認", /明日(?:[^。！\n]{0,12})(?:確認|交渉|ご連絡)|翌営業日/],
  ["営業開始", /営業開始(?:次第|後)|開き次第|始業/],
  ["本日中", /本日中/],
];
const PROMISE_RE = /(?:募集状況|空室|空き状況|管理会社|オーナー|貸主)[^。！\n]{0,20}(?:確認|問い?合わせ|交渉)[^。！\n]{0,12}(?:させて頂|いたし|致し|します)/;

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: convsRaw, error } = await sb.from("conversations").select("id, line_user_id, status").gte("updated_at", since).order("updated_at", { ascending: false }).limit(800);
  if (error) { console.log("conversations 読めず:", error.message); process.exit(1); }
  const convs = (convsRaw ?? []).filter((c) => !isTestConversation(c.id as string) && !String(c.line_user_id ?? "").startsWith("C") && !isPostApplyStatus(c.status as string | null));
  console.log(`会話 ${convs.length}（${DAYS}日・グループ・テスト用・申込以降を除く）`);

  const phrase: Record<string, Record<string, number>> = {}; // 言い方 → 曜日 → 件数
  const phraseBand: Record<string, Record<string, number>> = {};
  const promiseSent: Record<string, number> = {};          // 確認の約束を送った曜日
  const promiseBand: Record<string, number> = {};
  const gapBuckets: Record<string, Record<string, number>> = {}; // 約束の曜日 → 結果まで（〜30分・〜3時間・当日中・翌日・2日以上）
  const answered: Record<string, number> = {};             // 答えの AIX を送った曜日
  const answeredBand: Record<string, number> = {};
  const taskAnswered: Record<string, number> = {};         // line_tasks の resolved_at の曜日
  const taskAnsweredBand: Record<string, number> = {};
  const taskGap: Record<string, Record<string, number>> = {};
  const phoneBand: Record<string, number> = {};
  const staffBand: Record<string, number> = {};
  let phoneN = 0, staffN = 0, promiseN = 0, gapN = 0, taskN = 0;
  const perCompany = new Map<string, { n: number; weekend: number; holiday: number }>();
  let companyColumn = true;

  for (const c of convs) {
    const cid = c.id as string;
    const { data: ms } = await sb.from("messages").select("sender, created_at, text, is_aix_generated").eq("conversation_id", cid).gte("created_at", since).order("created_at").limit(4000);
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, sent_at, created_at, check_pattern").eq("conversation_id", cid).gte("created_at", since).order("created_at");
    const { data: tk } = await sb.from("line_tasks").select("task_type, status, created_at, resolved_at, result").eq("conversation_id", cid).eq("task_type", "property_check").gte("created_at", since);
    const staff = ((ms ?? []) as Array<{ sender: string; created_at: string; text: string | null }>).filter((m) => m.sender !== "customer" && (m.text ?? "").trim());
    const answers = ((ax ?? []) as Array<{ aix_type: string | null; sent_at: string | null; created_at: string }>).filter((a) => a.aix_type === "property_check_result").map((a) => a.sent_at ?? a.created_at);
    // ①③ 言い方と営業の終わり
    for (const m of staff) {
      const t = m.text ?? "";
      const j = jst(m.created_at);
      staffN++; inc(staffBand, hourBand(j.hour));
      if (/電話|お電話/.test(t)) { phoneN++; inc(phoneBand, hourBand(j.hour)); }
      for (const [name, re] of CLOSED_PHRASES) if (re.test(t) && /管理会社|営業時間|営業開始|定休|お休み/.test(t)) {
        phrase[name] ??= {}; inc(phrase[name], dayKind(m.created_at));
        phraseBand[name] ??= {}; inc(phraseBand[name], hourBand(j.hour));
      }
      // ② 確認の約束 → 次の結果の AIX までの時間
      if (PROMISE_RE.test(t)) {
        promiseN++; inc(promiseSent, dayKind(m.created_at)); inc(promiseBand, hourBand(j.hour));
        const t0 = Date.parse(m.created_at);
        const next = answers.map((a) => Date.parse(a)).filter((x) => x > t0).sort((a, b) => a - b)[0];
        if (next) {
          gapN++; const h = (next - t0) / 3600_000;
          const g = h < 0.5 ? "〜30分" : h < 3 ? "〜3時間" : jst(new Date(next).toISOString()).ymd === j.ymd ? "当日中" : h < 36 ? "翌日" : "2日以上";
          gapBuckets[dayKind(m.created_at)] ??= {}; inc(gapBuckets[dayKind(m.created_at)], g);
        }
      }
    }
    for (const a of answers) { inc(answered, dayKind(a)); inc(answeredBand, hourBand(jst(a).hour)); }
    // ② line_tasks（管理会社の答えが記録された時）
    for (const k of (tk ?? []) as Array<{ created_at: string; resolved_at: string | null; status: string }>) {
      if (!k.resolved_at) continue;
      taskN++; inc(taskAnswered, dayKind(k.resolved_at)); inc(taskAnsweredBand, hourBand(jst(k.resolved_at).hour));
      const h = (Date.parse(k.resolved_at) - Date.parse(k.created_at)) / 3600_000;
      const g = h < 0.5 ? "〜30分" : h < 3 ? "〜3時間" : jst(k.created_at).ymd === jst(k.resolved_at).ymd ? "当日中" : h < 36 ? "翌日" : "2日以上";
      taskGap[dayKind(k.created_at)] ??= {}; inc(taskGap[dayKind(k.created_at)], g);
    }
    // ④ 管理会社ごと（列があれば）
    if (companyColumn && answers.length) {
      const r = await sb.from("sent_properties").select("management_company").eq("conversation_id", cid).not("management_company", "is", null).limit(50);
      if (r.error) companyColumn = false;
      else for (const row of (r.data ?? []) as Array<{ management_company: string | null }>) {
        const name = String(row.management_company ?? "").trim(); if (!name) continue;
        const cur = perCompany.get(name) ?? { n: 0, weekend: 0, holiday: 0 };
        cur.n++; // 会社ごとの答えの曜日は、この会話の答えの AIX を割り当てる近似（1会話に複数会社がある時は薄まる）
        for (const a of answers) { const k = dayKind(a); if (k === "土" || k === "日") cur.weekend++; if (k === "祝") cur.holiday++; }
        perCompany.set(name, cur);
      }
    }
  }

  console.log("\n① スタッフの送信の言い方 × 送った曜日（件数のみ）");
  for (const k of Object.keys(phrase)) console.log(`  ${k}: ${table(phrase[k], DAY_ORDER)}｜時刻 ${table(phraseBand[k] ?? {}, BAND_ORDER)}`);
  console.log(`\n② 確認の約束 ${promiseN}件（曜日 ${table(promiseSent, DAY_ORDER)}｜時刻 ${table(promiseBand, BAND_ORDER)}）`);
  console.log(`   約束→結果の AIX まで（${gapN}件・約束を送った曜日ごと）:`);
  for (const d of DAY_ORDER) if (gapBuckets[d]) console.log(`   ${d}: ${table(gapBuckets[d], ["〜30分", "〜3時間", "当日中", "翌日", "2日以上"])}`);
  console.log(`   結果の AIX（物件確認した）を送った曜日: ${table(answered, DAY_ORDER)}｜時刻 ${table(answeredBand, BAND_ORDER)}`);
  console.log(`   line_tasks（物件確認）で答えが記録された ${taskN}件: 曜日 ${table(taskAnswered, DAY_ORDER)}｜時刻 ${table(taskAnsweredBand, BAND_ORDER)}`);
  for (const d of DAY_ORDER) if (taskGap[d]) console.log(`   タスク 作った曜日 ${d} → 答えまで: ${table(taskGap[d], ["〜30分", "〜3時間", "当日中", "翌日", "2日以上"])}`);
  console.log(`\n③ スタッフの送信 ${staffN}件の時刻: ${table(staffBand, BAND_ORDER)}`);
  console.log(`   電話に触れた送信 ${phoneN}件の時刻: ${table(phoneBand, BAND_ORDER)}（19時台以降が何件あるか・弊社の営業の終わり 21時の実際）`);
  if (!companyColumn) console.log("\n④ sent_properties に management_company の列が無い＝管理会社ごとの集計は今回なし（列の名前が分かれば足す）");
  else {
    const rows = [...perCompany.values()].filter((v) => v.n >= 5).sort((a, b) => b.n - a.n);
    console.log(`\n④ 管理会社ごと（${rows.length}社・5件以上のみ・名前は出さない）: ` + (rows.length ? rows.map((v, i) => `会社${String.fromCharCode(65 + i)} 物件${v.n}・土日に答え${v.weekend}・祝に答え${v.holiday}`).join(" ／ ") : "5件以上の会社なし"));
  }
  console.log("\n読み方: 土・日・祝の列に「答えが記録された／結果の AIX を送った」件数がどれだけあるか、水曜など特定の曜日だけ極端に少ないかを見る。少なければ time-facts.ts の『休みの扱い』をその曜日に直す。時刻の表で 18時台・19〜21時に答えがあれば管理会社の閉じる時刻の線を直す。");
})();
