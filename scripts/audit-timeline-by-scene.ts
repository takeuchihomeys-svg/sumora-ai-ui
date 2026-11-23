// scripts/audit-timeline-by-scene.ts — 台帳 #500（土台「時系列」の場面ごとの決まり）: 場面ごとに、竹内さん本人（messages.staff_writer=takeuchi）の送信が
//   時系列（前に言った事・約束の日・内覧の日）に触れている番を数える（読むだけ・LLM なし・2026-11-23 作業員L）
//   決まりにするのは、竹内さんの番が n 10 以上で、ある形が過半数の場面だけ（割れ・n 不足は決まりにしない）
//   実行: npx tsx --env-file=.env.local scripts/audit-timeline-by-scene.ts [日数=14]（60日は重いので夜に・JST 22〜9時）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
const days = Number(process.argv[2] ?? "14");
const SCENE: Array<[string, RegExp]> = [
  ["短いお礼", /^返信:短い了承・お礼$/], ["検討中", /^返信:検討中・一時保留$/], ["条件", /^返信:条件提示$|^返信:条件フォーム受領$|^AIX:condition_hearing$/],
  ["物件を送ってきた", /^返信:持ち込み物件$|^AIX:property_check_result$|^AIX:acknowledge_check$/], ["物件を送る", /^AIX:property_send$|^AIX:property_recommendation$/],
];
const FORMS: Array<[string, RegExp]> = [
  ["前に言った事", /先日|以前|前回|先ほど|先程|お伝え(?:させて頂|させていただ|し)(?:いた|きました|ました)|お送りさせて(?:頂|いただ)きました|お話し(?:させて頂|させていただ)いた|(?:仰|おっしゃ)っていた|頂いていた|いただいていた|(?:頂|いただ)きました(?:ご条件|物件|お部屋)/],
  ["約束の日", /(?:明日|明朝|本日中|今日中|週明け|来週|(?:1[0-2]|0?[1-9])\s*[\/月]\s*(?:3[01]|[12]?[0-9])\s*日?|[月火水木金土日]曜)[^。！!？?\n]{0,20}(?:お送り|ご連絡|ピックアップ|確認|ご報告)させて/],
  ["内覧の日", /(?:(?:1[0-2]|0?[1-9])\s*[\/月]\s*(?:3[01]|[12]?[0-9])|明日|本日|[月火水木金土日]曜)[^。！!？?\n]{0,25}(?:ご案内|ご内覧|内覧)|ご内覧(?:の)?(?:日|際)|ご案内(?:の)?(?:日|際)/],
];
(async () => {
  const jstH = new Date(Date.now() + 9 * 36e5).getUTCHours();
  if (days > 14 && jstH >= 9 && jstH < 22 && !process.argv.includes("--force")) throw new Error("14日を超える読みは夜だけ（JST 22〜9時）。営業時間は 14日まで");
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const turns: Array<{ id: number; conversation_id: string; customer_turn_at: string; scene_key: string | null; staff_texts: Array<{ at: string; text: string }> | null }> = [];
  for (let f = 0; f < 20000; f += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, staff_texts").gte("customer_turn_at", since).range(f, f + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as typeof turns));
    if ((data ?? []).length < 1000) break;
  }
  // 書き手: 番の送信の時刻の staff の通（会話と時刻で引く）
  const byConv = new Map<string, typeof turns>();
  for (const t of turns) byConv.set(t.conversation_id, [...(byConv.get(t.conversation_id) ?? []), t]);
  const writer = new Map<string, string | null>(); // conv@at → writer
  const convs = [...byConv.keys()];
  for (let k = 0; k < convs.length; k += 5) await Promise.all(convs.slice(k, k + 5).map(async (c) => {
    const { data } = await sb.from("messages").select("created_at, staff_writer").eq("conversation_id", c).eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since).limit(2000);
    for (const m of (data ?? []) as Array<{ created_at: string; staff_writer: string | null }>) writer.set(`${c}@${Date.parse(m.created_at)}`, m.staff_writer);
  }));
  { const d: Record<string, number> = {}; for (const w of writer.values()) d[String(w)] = (d[String(w)] ?? 0) + 1; console.log("通の書き手", JSON.stringify(d)); }
  const res: Record<string, { n: number; forms: Record<string, number>; any: number }> = {};
  let unk = 0;
  for (const t of turns) {
    const sc = SCENE.find(([, re]) => re.test(String(t.scene_key ?? "")))?.[0];
    if (!sc) continue;
    const texts = (t.staff_texts ?? []).filter((x) => { const w = writer.get(`${t.conversation_id}@${Date.parse(x.at)}`); if (w === undefined) unk++; return w === "takeuchi"; });
    if (!texts.length) continue;
    const all = texts.map((x) => String(x.text ?? "").normalize("NFKC")).join("\n");
    const o = (res[sc] ??= { n: 0, forms: {}, any: 0 });
    o.n++;
    let hit = false;
    for (const [name, re] of FORMS) if (re.test(all)) { o.forms[name] = (o.forms[name] ?? 0) + 1; hit = true; }
    if (hit) o.any++;
  }
  console.log(`${days}日・番 ${turns.length}・書き手が引けない通 ${unk}`);
  for (const [sc] of SCENE) { const o = res[sc]; if (!o) { console.log(`${sc}: n=0`); continue; } console.log(`${sc}: 竹内さんの番 n=${o.n}・時系列に触れた ${o.any}（${Math.round((o.any / o.n) * 100)}%）・${FORMS.map(([f]) => `${f} ${o.forms[f] ?? 0}`).join("・")}`); }
})();
