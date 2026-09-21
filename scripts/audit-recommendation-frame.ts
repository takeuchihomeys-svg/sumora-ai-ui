// AIX【物件オススメ】の冒頭フレームが事実と合っているか（読み取りのみ）
//
// 2026-09-21 竹内「AIXテンプレートでの言い回し、複数物件送った中では
//   『お送りさせて頂きましたお部屋の中でも〜』の言い回しを使ったり、新着物件なら新着物件の言い回しを使う。
//   別のスタッフが送ってる質の悪い言い回しもあるから、そこも含めて改善する。直近の会話をみて。」
//
// ■ 先に引いた設計知見
//   「AIXテンプレートの冒頭フレームはルールベースで確定させる」
//     → 冒頭フレームは事実（件数・種別・鮮度）から決め、LLM には「そのフレーム内でどう書くか」だけ任せる
//   「実例（⭐固定シード）の偏りがフレーム選択をLLMに引き起こす」
//     → 実例が特定のフレームに偏ると、どのシナリオでもそのフレームに引き寄せられる
//   「同じ事実に数え方が2つあると、後から足した方だけが新しくなる」
//     → 件数は brainSentPropertyCount（物件の件数）が正・priorSentPropertyCount（送付回数）ではない
//
// ■ ここで測ること
//   ① シナリオが何に決まっているか（aix_generate_log.scenario）
//   ② 生成文の冒頭フレームがシナリオと合っているか（compare なのに新着型 等）
//   ③ スタッフの実送信でどのフレームが使われているか（＝正解の分布）
//   ④ 学習に使う実例（☆）にどんな言い回しが入っているか（質の悪い物が混ざっていないか）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommendation-frame.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 90);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
/** ⚠ route.ts の COMPARE_FRAME_RE / NEW_LISTING_FRAME_RE と同じ形にすること（四者同名） */
const COMPARE_FRAME_RE = /(お送り|ご紹介|送らせて|送付|お渡し)[^。！\n]{0,20}(中でも|中から)/;
const NEW_LISTING_FRAME_RE = /(新着で|新着物件|募集に出ました|募集にでました|募集でました|募集が出ました)/;
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉");

function frameOf(text: string): "compare" | "new_listing" | "other" {
  const head = text.split("\n").slice(0, 3).join("\n");
  if (COMPARE_FRAME_RE.test(head)) return "compare";
  if (NEW_LISTING_FRAME_RE.test(head)) return "new_listing";
  return "other";
}

/**
 * 物件カードだけの通（🌟〇〇 302号室／・設備…）は言い回しの話ではないので外す。
 * ⚠ 最初これを混ぜて数えたら「other 62.8%」になり、フレームが使われていないように見えた。
 *   実際は AIX【物件オススメ】が **物件カードの通と訴求文の通の2通**に分かれているため
 *   （竹内さんのスクショも 16:25 カード → 16:27 訴求文）。
 */
function isCardOnly(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  // 1行目が 🌟/【 で始まる物件名で、以降が「・」の箇条書き中心なら物件カード
  const headIsProperty = /^[🌟【]/u.test(lines[0]);
  const bulletRatio = lines.slice(1).filter((l) => /^[・◎●\-–—]/.test(l)).length / Math.max(1, lines.length - 1);
  return headIsProperty && (lines.length === 1 || bulletRatio >= 0.5);
}

async function page(table: string, select: string, order: string, days: number, eq?: [string, string]) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    let q = sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (eq) q = q.eq(eq[0], eq[1]);
    const { data, error } = await q;
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  // ── ① 生成のログ（シナリオが何に決まったか）───────────────────────
  const logs = await page("aix_generate_log", "id, action_type, generated_text, conditions_snapshot, created_at", "created_at", DAYS);
  const recLogs = logs.filter((r) => String(r.action_type ?? "") === "property_recommendation");
  console.log(`=== ① 生成ログ（直近${DAYS}日）AIX全体 ${logs.length}件 / 物件オススメ ${recLogs.length}件 ===\n`);

  type Snap = { scenario?: string | null; pickup_type?: string | null; brain_sent_property_count?: number | null };
  const withScenario = recLogs.map((r) => {
    const snap = (r.conditions_snapshot ?? {}) as Snap;
    return { text: String(r.generated_text ?? ""), scenario: snap.scenario ?? null, pickup: snap.pickup_type ?? null };
  }).filter((x) => x.text);

  const byScenario = new Map<string, { n: number; frames: Map<string, number> }>();
  for (const x of withScenario) {
    const k = x.scenario ?? "(記録なし)";
    const c = byScenario.get(k) ?? { n: 0, frames: new Map() };
    c.n++;
    const f = frameOf(x.text);
    c.frames.set(f, (c.frames.get(f) ?? 0) + 1);
    byScenario.set(k, c);
  }
  console.log(`   シナリオ            件数   生成文の冒頭フレーム`);
  for (const [k, c] of [...byScenario.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   ${k.padEnd(18)} ${String(c.n).padStart(5)}   ${[...c.frames.entries()].map(([f, n]) => `${f} ${n}`).join(" / ")}`);
  }

  // ② シナリオと生成文が食い違っている物を出す
  console.log(`\n=== ② シナリオと生成文が食い違っている物 ===`);
  const bad = withScenario.filter((x) => {
    if (!x.scenario) return false;
    const f = frameOf(x.text);
    if (x.scenario === "compare") return f === "new_listing";
    if (x.scenario === "new_listing") return f === "compare";
    // compare 以外で比較表現を使っていたら事実と違う
    return f === "compare";
  });
  console.log(`   ${bad.length}件 / ${withScenario.filter((x) => x.scenario).length}件（${pct(bad.length, withScenario.filter((x) => x.scenario).length)}）`);
  for (const x of bad.slice(0, 8)) {
    console.log(`     [${x.scenario} / pickup=${x.pickup ?? "-"}] → ${frameOf(x.text)}`);
    console.log(`       ${mask(x.text).split("\n")[0].slice(0, 80)}`);
  }

  // ── ③ スタッフの実送信でどのフレームが使われているか ──────────────
  const ex = await page("ai_reply_examples", "id, ai_draft, sent_reply, aix_action, was_ai_used, created_at", "created_at", DAYS);
  const recExAll = ex.filter((r) => String(r.aix_action ?? "") === "property_recommendation" && String(r.sent_reply ?? "").trim());
  const recEx = recExAll.filter((r) => !isCardOnly(String(r.sent_reply)));
  console.log(`\n=== ③ スタッフの実送信（訴求文だけ）${recEx.length}件 / 全${recExAll.length}件（物件カードだけの通 ${recExAll.length - recEx.length}件は外した）===`);
  const sentFrames = new Map<string, number>();
  for (const r of recEx) {
    const f = frameOf(String(r.sent_reply));
    sentFrames.set(f, (sentFrames.get(f) ?? 0) + 1);
  }
  for (const [f, n] of [...sentFrames.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${f.padEnd(12)} ${String(n).padStart(4)}件（${pct(n, recEx.length)}）`);
  }

  // ④ 実送信の冒頭1行を種類ごとに出す（言い回しの実物・質を目で読む）
  console.log(`\n=== ④ 実送信の冒頭1行（言い回しの実物）===`);
  const headCount = new Map<string, number>();
  for (const r of recEx) {
    const head = mask(String(r.sent_reply)).split("\n")[0].trim();
    if (head) headCount.set(head, (headCount.get(head) ?? 0) + 1);
  }
  const heads = [...headCount.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`   ${heads.length}種類の書き出し（上位20）`);
  for (const [h, n] of heads.slice(0, 20)) console.log(`   ${String(n).padStart(3)}回  ${h.slice(0, 70)}`);

  // ⑤ AI が書いた物をスタッフが直したか（質の判断）
  console.log(`\n=== ⑤ AI の下書きをスタッフが直したか ===`);
  const pairs = recEx.filter((r) => String(r.ai_draft ?? "").trim() && !isCardOnly(String(r.ai_draft)));
  const same = pairs.filter((r) => String(r.ai_draft).trim() === String(r.sent_reply).trim()).length;
  console.log(`   下書きと実送信が揃う ${pairs.length}件 ／ そのまま送った ${same}件（${pct(same, pairs.length)}）`);
  const frameChanged = pairs.filter((r) => frameOf(String(r.ai_draft)) !== frameOf(String(r.sent_reply)));
  console.log(`   **冒頭フレームを変えられた ${frameChanged.length}件（${pct(frameChanged.length, pairs.length)}）**`);
  for (const r of frameChanged.slice(0, 8)) {
    console.log(`     AI(${frameOf(String(r.ai_draft))}): ${mask(String(r.ai_draft)).split("\n")[0].slice(0, 60)}`);
    console.log(`     実送信(${frameOf(String(r.sent_reply))}): ${mask(String(r.sent_reply)).split("\n")[0].slice(0, 60)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
