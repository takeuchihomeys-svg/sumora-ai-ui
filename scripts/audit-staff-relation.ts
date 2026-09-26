// scripts/audit-staff-relation.ts — テンプレート最適化（AIX→テンプレ）の挨拶を「こちらの発言同士の関係」で監査する（読むだけ・LLM なし）
//
// 2026-09-26 竹内「こちらが言ったことの関係性を時刻や返信も踏まえて…たとえば AIX からテンプレートの場合は挨拶入れない等」
// 対象: template_selection_logs（最適化した文 adapted_text × スタッフが実際に送った文 final_sent_text）直近 DAYS 日・YUMA 除く。
// 各行の「今日こちらが会話文を送ったか」を DB の messages から daily-greeting.ts の staffTalkedToday（本番と同じ関数）で決め、
//   ① 出口（applyDailyGreeting の消す方向）を当てた前後と、スタッフが送った文の挨拶の有無を並べる（誤削除＝消したのにスタッフは残した）
//   ② 入口の判定の変更（旧: 画像・資料も数える sentByStaffToday → 新: 会話文だけ）で割れる行と、スタッフの形を並べる
// 9/22 15:15 JST（「今日初めてじゃないときはお世話になっておりますはつかわない」の方針）より前は、スタッフの形が方針と違うので分けて数える。
//
// 結論（2026-09-26 実行）:
//   - 方針以降・会話文を送った日×最適化文に挨拶 → 9件（送った6件はスタッフが6件とも消した・残した0件）＝出口の誤削除0 → 入れた
//   - 資料文だけの日×最適化文に挨拶 → スタッフは 37/38 で残す → 出口は通さない・入口も消さない（判定を会話文だけに変えた）
//   - 作らなかった物（天井が小さい・過半数の決まりが無い）は generate-reply/route.ts のコメントと memory/dept_line_reply.md に記録
//
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-relation.ts [DAYS=180] [SHOW=POST|pre|<セルの一部>]
//   出力は件数と、名前・電話を伏せた例だけ。
import { createClient } from "@supabase/supabase-js";
import { applyDailyGreeting, staffTalkedToday, sentByStaffToday } from "../app/lib/daily-greeting";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const POLICY_AT = "2026-09-22T06:15:37Z"; // commit 28356b6d（1日1回の挨拶）
const JST = 9 * 3600_000;
const day = (t: number) => new Date(t + JST).toISOString().slice(0, 10);
const HEAD = (s: string) => s.split("\n").filter((l) => l.trim()).slice(0, 2).join("\n");
const GREET = /お世話になっております|夜分(?:遅く)?に?(?:大変)?失礼/;
const mask = (s: string) => s.replace(/[^\s\n！!。、]{1,12}(さん|様)/g, "〇〇$1").replace(/\d{2,4}-?\d{3,4}-?\d{4}/g, "***");
const DAYS = Number(process.env.DAYS ?? 180);
const SHOW = process.env.SHOW ?? "";

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data, error } = await sb.from("template_selection_logs")
    .select("id,created_at,conversation_id,template_category,adapted_text,final_sent_text")
    .gte("created_at", since).not("adapted_text", "is", null).order("created_at").limit(5000);
  if (error) throw error;
  const rows = (data ?? []).filter((r) => r.conversation_id && r.conversation_id !== YUMA);
  const cells: Record<string, number> = {};
  const inc = (k: string) => (cells[k] = (cells[k] ?? 0) + 1);
  const ex: Record<string, string[]> = {};
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    const dayStart = Date.parse(day(t) + "T00:00:00+09:00");
    const { data: msgs } = await sb.from("messages").select("sender,text,created_at").eq("conversation_id", r.conversation_id)
      .eq("sender", "staff").gte("created_at", new Date(dayStart).toISOString()).lt("created_at", new Date(t + 5_000).toISOString()).order("created_at");
    const staff = (msgs ?? []).map((m) => ({ sender: m.sender as string, text: m.text as string | null, createdAt: m.created_at as string }));
    const talked = staffTalkedToday(staff, t + 5_000);
    const sentAny = sentByStaffToday(staff, t + 5_000);
    const era = r.created_at >= POLICY_AT ? "POST" : "pre ";
    const adapted = r.adapted_text as string;
    const aHas = GREET.test(HEAD(adapted));
    const fHas = r.final_sent_text ? GREET.test(HEAD(r.final_sent_text)) : null;
    const staffForm = fHas === null ? "未送信" : fHas ? "スタッフ挨拶あり" : "スタッフ挨拶なし";
    // ① 出口
    if (talked && aHas) {
      const out = applyDailyGreeting(adapted, { staffSentToday: true, greetingPhrase: "", name: "" });
      const k = `${era} ①出口 会話文あり×最適化文に挨拶 → ${out.action} / ${staffForm}${out.action === "removed" && fHas ? "  ←誤削除" : ""}`;
      inc(k);
      if (SHOW && k.includes(SHOW)) (ex[k] ??= []).length < 6 && ex[k].push(
        `[${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 16)} ${r.template_category}]\n 前: ${mask(HEAD(adapted))}\n 後: ${mask(HEAD(out.text))}\n 送: ${mask(HEAD(r.final_sent_text ?? "(未送信)"))}`);
    } else {
      inc(`${era} ①出口 対象外（${talked ? "会話文あり" : sentAny ? "資料文だけ" : "今日まだ"}×最適化文に挨拶${aHas ? "あり" : "なし"}） / ${staffForm}`);
    }
    // ② 入口の判定の変更で割れる行（旧は消す・新は残す）
    if (sentAny && !talked) {
      const k = `${era} ②入口 資料文だけの日（旧=消す・新=残す）×最適化文に挨拶${aHas ? "あり" : "なし"} / ${staffForm}`;
      inc(k);
      if (SHOW && k.includes(SHOW)) (ex[k] ??= []).length < 4 && ex[k].push(
        `[${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 16)} ${r.template_category}]\n 今日の送信: ${staff.map((m) => mask((m.text ?? "").slice(0, 18).replace(/\n/g, " "))).join(" / ")}\n 最適化: ${mask(HEAD(adapted))}\n 送: ${mask(HEAD(r.final_sent_text ?? "(未送信)"))}`);
    }
  }
  console.log(`template_selection_logs ${rows.length}件（直近${DAYS}日・YUMA除く）\n`);
  for (const [k, v] of Object.entries(cells).sort()) console.log(String(v).padStart(4), k);
  for (const [k, v] of Object.entries(ex)) { console.log(`\n### ${k}`); v.forEach((s) => console.log(s + "\n")); }
})();
