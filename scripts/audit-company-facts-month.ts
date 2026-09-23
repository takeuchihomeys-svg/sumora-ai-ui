// S6「会社の事実」の今月全件当て（読み取りのみ）
//
// 2026-09-23 Fable5.1 実測: 今日入れた app/lib/company-facts.ts の matchCompanyFacts を
//   今月のお客様の発言に当て、当たった全件を**目で読む**ための一覧を出す。
//   ・誤当たり   ＝ 渡してはいけない場面（同じ語の別の意味・既に済んでいる場面）
//   ・当たり漏れ ＝ 実送信で事実を答えているのに、直前のお客様の発言に当たっていない
//   ・その時スタッフが実際にした事（3時間以内の AIX・次のスタッフ送信・下書きの有無）を並べる
//
// 実行: npx tsx --env-file=.env.local scripts/audit-company-facts-month.ts [SINCE=2026-08-31T15:00:00Z]
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SINCE = process.env.SINCE ?? "2026-08-31T15:00:00Z";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Msg = { id: string; conversation_id: string; sender: string | null; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
type Ex = { conversation_id: string; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null; aix_action: string | null; created_at: string };

async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/https?:\/\/\S+/g, "[URL]").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/\s+/g, " ").trim();
const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

/** 実送信側で「事実を答えている」形（audit-company-facts.ts の TOPICS を流用・当たり漏れの検出用） */
const STAFF_FACT: Array<{ id: string; re: RegExp }> = [
  { id: "store", re: /(オンライン専門|来店(不可|は|での)|店舗(では|は)?(無|な)(く|い)|事務所(となり|ではあり))/ },
  { id: "emergency_contact", re: /(3親等以内|緊急連絡先[^。\n]{0,12}(必須|必要))/ },
  { id: "apply_docs", re: /本人確認書類[^。\n]{0,20}(裏表|写真|お送り)/ },
  { id: "cancel", re: /(審査|保証会社)[^。\n]{0,14}(通過|通る)[^。\n]{0,10}(まで|前)[^。\n]{0,10}キャンセル|キャンセル(料)?[^。\n]{0,10}(かかりません|無料|発生しません|一切)/ },
  { id: "viewing_method", re: /オンライン(内覧|内見)/ },
  { id: "room_photo", re: /(室内|お部屋)[^。\n]{0,6}(写真|撮影|イメージ)[^。\n]{0,12}(承|可能|させて|添付|お送り)/ },
  { id: "prorated_rent", re: /日割(家賃|り家賃)|前家賃/ },
  { id: "area", re: /(大阪府[^。\n]{0,6}(全域|全物件)|大阪[^。\n]{0,4}全域[^。\n]{0,10}(対応|ご紹介))/ },
];

async function main() {
  const msgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated")
    .gte("created_at", SINCE).neq("conversation_id", YUMA).order("created_at").range(a, b));
  const aix = await all<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", SINCE).range(a, b));
  const exs = await all<Ex>((a, b) => sb.from("ai_reply_examples").select("conversation_id, customer_message, ai_draft, sent_reply, was_ai_used, aix_action, created_at").gte("created_at", SINCE).range(a, b));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const l = byConv.get(m.conversation_id) ?? []; l.push(m); byConv.set(m.conversation_id, l); }

  const cust = msgs.filter((m) => m.sender === "customer" && (m.text ?? "").trim() && m.text !== "[画像]");
  const staffAll = msgs.filter((m) => m.sender !== "customer" && (m.text ?? "").trim() && m.text !== "[画像]");
  console.log(`今月（${SINCE}〜）お客様の発言 ${cust.length}通 ／ こちらの送信 ${staffAll.length}通 ／ 会話 ${byConv.size}\n`);

  // ── 当たり全件
  const hits = cust.map((m) => ({ m, facts: matchCompanyFacts(m.text) })).filter((x) => x.facts.length);
  const cnt: Record<string, number> = {};
  for (const h of hits) for (const f of h.facts) cnt[f.id] = (cnt[f.id] ?? 0) + 1;
  console.log(`【当たった発言】${hits.length}通 ／ 事実別: ${Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);

  let idx = 0;
  const stat = { draft: 0, aix3h: 0, staffNext: 0, aiUsed: 0 };
  for (const h of hits) {
    idx++;
    const conv = byConv.get(h.m.conversation_id) ?? [];
    const t = Date.parse(h.m.created_at);
    const nextStaff = conv.filter((x) => x.sender !== "customer" && Date.parse(x.created_at) > t && Date.parse(x.created_at) - t <= 48 * 3600_000 && (x.text ?? "").trim() && x.text !== "[画像]").slice(0, 3);
    const prevStaff = [...conv].reverse().find((x) => x.sender !== "customer" && Date.parse(x.created_at) < t && (x.text ?? "").trim() && x.text !== "[画像]");
    const aix3 = aix.filter((a) => a.conversation_id === h.m.conversation_id && Date.parse(a.created_at) >= t && Date.parse(a.created_at) - t <= 3 * 3600_000);
    const ex = exs.filter((e) => e.conversation_id === h.m.conversation_id && Math.abs(Date.parse(e.created_at) - t) <= 6 * 3600_000 && Date.parse(e.created_at) >= t - 60_000);
    if (ex.length) stat.draft++;
    if (aix3.length) stat.aix3h++;
    if (nextStaff.length) stat.staffNext++;
    if (ex.some((e) => e.was_ai_used)) stat.aiUsed++;
    const staffFactHit = nextStaff.flatMap((s) => STAFF_FACT.filter((f) => f.re.test(String(s.text ?? ""))).map((f) => f.id));
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`#${idx} [${jst(h.m.created_at)}] conv=${h.m.conversation_id.slice(0, 8)} 当たり=${h.facts.map((f) => f.id).join(",")}`);
    if (prevStaff) console.log(`  前のこちら: ${short(mask(String(prevStaff.text)), 120)}`);
    console.log(`  客: ${short(mask(String(h.m.text)), 300)}`);
    console.log(`  AIX(3h): ${aix3.map((a) => a.aix_type).join(",") || "なし"} ／ 下書き: ${ex.length ? ex.map((e) => `${e.aix_action ?? "通常"}${e.was_ai_used ? "(そのまま)" : "(編集)"}`).join(",") : "なし"} ／ 次のこちら送信で事実: ${staffFactHit.join(",") || "なし"}`);
    for (const s of nextStaff) console.log(`  次のこちら[${jst(s.created_at)}${s.is_aix_generated ? "/AIX" : ""}]: ${short(mask(String(s.text)), 260)}`);
    for (const e of ex) if (e.ai_draft) console.log(`  下書き: ${short(mask(String(e.ai_draft)), 260)}`);
  }
  console.log(`\n【当たり ${hits.length}通の内訳】下書きが出た ${stat.draft} ／ 3時間以内に AIX ${stat.aix3h} ／ 48時間以内にこちらから送信 ${stat.staffNext} ／ 下書きそのまま ${stat.aiUsed}`);

  // ── 当たり漏れ: こちらの送信で事実を答えているのに、直前3通のお客様の発言が当たっていない
  console.log(`\n\n【当たり漏れの候補】こちらの送信で事実を答えている（STAFF_FACT）のに、直前3通のお客様発言に当たっていない`);
  let miss = 0; const missCnt: Record<string, number> = {};
  for (const s of staffAll) {
    const fids = STAFF_FACT.filter((f) => f.re.test(String(s.text ?? ""))).map((f) => f.id);
    if (!fids.length) continue;
    const conv = byConv.get(s.conversation_id) ?? [];
    const t = Date.parse(s.created_at);
    const prevCust = [...conv].reverse().filter((x) => x.sender === "customer" && Date.parse(x.created_at) < t && (x.text ?? "").trim()).slice(0, 3);
    const matched = new Set(prevCust.flatMap((x) => matchCompanyFacts(x.text).map((f) => f.id)));
    const unmatched = fids.filter((f) => !matched.has(f));
    if (!unmatched.length) continue;
    miss++;
    for (const f of unmatched) missCnt[f] = (missCnt[f] ?? 0) + 1;
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`[${jst(s.created_at)}${s.is_aix_generated ? "/AIX" : ""}] conv=${s.conversation_id.slice(0, 8)} 答えた事実=${unmatched.join(",")}`);
    for (const x of [...prevCust].reverse()) console.log(`  客[${jst(x.created_at)}]: ${short(mask(String(x.text)), 160)}`);
    console.log(`  こちら: ${short(mask(String(s.text)), 260)}`);
  }
  console.log(`\n当たり漏れ候補 ${miss}通 ／ 事実別: ${Object.entries(missCnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
