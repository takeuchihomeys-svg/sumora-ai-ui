// scripts/aix-why-anatomy.ts — 竹内さんが押した AIX の「なぜこの AIX か」の読み解き（DeepSeek の下読み・本番の書き込みなし・LINE に送らない）
//
// 2026-11-03 竹内さん「AIX 選択している場面も、なんでこの AIX なのかちゃんと理解すれば、より強い」（KB P1・P0 04ca13be『竹内さんの文の解剖』の AIX 版）・作業員1:
//   ①竹内さん本人の AIX の送信（messages.staff_writer='takeuchi'・sure）を、ボタン×ピッカーごとに偏りなく約150件選ぶ
//   ②1件ずつ: 場面・直前のお客様の発言・その時に分かっていた事／分かっていなかった事（台帳・状況のまとめをその時刻で切る）・
//     なぜこのボタン×ピッカーか・似た候補をなぜ選ばなかったか・返信でなく AIX にした理由（スタッフしか分からない事）を DeepSeek で下読み
//   ③統括の札で同じ番を選ばせ（--compare と同じ形）、竹内さんと違った番だけを「食い違い」として見直しの一覧に出す
//   ④竹内さんに見てもらう10件（食い違い・札の薄い鍵を優先）を並べて出す
//   伏せ: 申込の書類の手前で切る・名前・URL・号室・電話。個人の値が残る番は外す（memory/test_protocol_brain.md 6）
//   時間: DB の読みが多い（1件あたり8本前後）ので、夜（22時〜）か土日に回す。DeepSeek もその時間は安い
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/aix-why-anatomy.ts [--n=150] [--per-key=6] [--days=180] [--max-usd=2] [--out=<dir>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogKeyOfPress, buttonOfKey, topicKey, AIX_CATALOG } from "../app/lib/aix-catalog";
import { BRAIN_AIX_LABELS } from "../app/lib/aix-button-view";
import { AIX_COMMANDER_SYSTEM, AIX_PAIRS, commanderUserText, parseCommanderAnswer } from "../app/lib/aix-commander";
import { cutBeforeApplicationMaterial, piiValueSignal, applicationMaterialReason } from "../app/lib/test-pii-guard";
import { isTestConversation } from "../app/lib/test-conversations";
import { addressNamesOf } from "./lib/brain-exam-mask";
import { examCacheRoot } from "./lib/llm-cassette";
import { sb, situationText, deepseekJson, cost, maskForLlm } from "./lib/aix-eval-common";
import type { AixDeskCard } from "../app/lib/aix-desk-types";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "150")); const PER_KEY = Number(arg("per-key", "6")); const DAYS = Number(arg("days", "180")); const MAX_USD = Number(arg("max-usd", "2"));
const OUT = arg("out", join(examCacheRoot(), "aix-why"));

/** 11/03 夜 指揮役: 押した鍵の名前と使う場面（札が無い鍵も・下読みが cost_explain を「見積書送る」と読んだ＝名前を渡していなかった） */
function pressedLabel(key: string): string {
  const c = cardsForLabel[key];
  if (c?.button) return `${c.button}${c.picker ? ` → ${c.picker}` : ""}`;
  const b = buttonOfKey(key), e = AIX_CATALOG.find((x) => x.key === key) ?? AIX_CATALOG.find((x) => buttonOfKey(x.key) === b);
  return `${(BRAIN_AIX_LABELS as Record<string, string>)[b] ?? b}${e?.when ? `・使う場面: ${e.when}` : ""}`;
}
let cardsForLabel: Record<string, { button?: string; picker?: string | null }> = {};
type Usage = { conversation_id: string; aix_type: string | null; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; line_message_id: string | null; created_at: string; sent_at: string | null };

const ANATOMY_SYS = [
  "あなたは大阪の賃貸仲介（スモラ）の社長・竹内さんの AIX（スタッフが確かめた事・資料を送る道具）の選び方を読み解く係です。",
  "竹内さんがこの番で押したボタン×ピッカーについて、会話・状況のまとめ・担当の札だけを根拠に、なぜそれを選んだかを読み解きます。推測で事実を足さない（根拠の無い所は「分からない」）。",
  "会話の各行の頭に時刻があります。AIX は、直前のお客様の発言への答えとは限りません（前の質問への答え・スタッフが送り続けていた続き）。まず、どの発言への答えかを決めてから読み解きます。",
  "返信でなく AIX の理由（why_aix）は、担当の札の「送る中身（スタッフだけが知る事）」に書いてある物だけから書く。札に無い理由（「竹内さんだけでは送れない」等）を作らない。札に無ければ「札に無い」と書く。",
  "出力は JSON だけ: {",
  '  "answered": "答えた発言（会話の行の時刻 HH:MM）か staff_continuation（スタッフが送り続けていた続き・お客様の発言への答えではない）",',
  '  "scene": "場面（一言）",',
  '  "known": ["その時に分かっていた事（台帳・会話から）"], "unknown": ["分かっていなかった事（スタッフが確かめて初めて分かる事）"],',
  '  "why_this": "なぜこのボタン×ピッカーか（1〜2文）",',
  '  "why_not": [{"key": "似た候補の鍵", "why": "なぜ選ばなかったか"}],',
  '  "why_aix": "返信でなく AIX にした理由（スタッフしか分からない事は何か）",',
  '  "axis": "この番から言える見分けの軸（担当の札に足す1文・一般化して書く・固有名詞を入れない）"',
  "}",
].join("\n");

(async () => {
  if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("LLM_TEST_MODE=deepseek-all を付けて流す");
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const h = await setupLlmTest("aix-why-anatomy");
  try {
    const cards: Record<string, AixDeskCard> = (JSON.parse(readFileSync(join(examCacheRoot(), "aix-desk", "cards.json"), "utf8")) as { cards: Record<string, AixDeskCard> }).cards;
    cardsForLabel = cards as unknown as Record<string, { button?: string; picker?: string | null }>;
    // ① 竹内さんの AIX の送信（ボタン×ピッカーごとに新しい順に PER_KEY 件まで）
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    const usages: Usage[] = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, line_message_id, created_at, sent_at").gte("created_at", since).order("created_at", { ascending: false }).range(i, i + 999);
      if (error) throw new Error(error.message);
      usages.push(...((data ?? []) as Usage[]));
      if ((data ?? []).length < 1000) break;
    }
    const lmIds = usages.map((u) => u.line_message_id).filter((x): x is string => !!x);
    const owner = new Set<string>();
    for (let i = 0; i < lmIds.length; i += 200) {
      const { data } = await sb.from("messages").select("line_message_id, staff_writer, staff_writer_confidence").in("line_message_id", lmIds.slice(i, i + 200));
      for (const m of (data ?? []) as Array<{ line_message_id: string; staff_writer: string | null; staff_writer_confidence: string | null }>) if (m.staff_writer === "takeuchi" && m.staff_writer_confidence === "sure") owner.add(m.line_message_id);
    }
    const perKey = new Map<string, Usage[]>();
    for (const u of usages) {
      if (!u.line_message_id || !owner.has(u.line_message_id) || isTestConversation(u.conversation_id)) continue;
      const key = catalogKeyOfPress({ aix_type: u.aix_type, check_pattern: u.check_pattern, send_mode: u.send_mode, app_sub_mode: u.app_sub_mode, picker_choices: u.picker_choices, text: u.generated_text }).key;
      const l = perKey.get(key) ?? []; if (l.length < PER_KEY) l.push(u); perKey.set(key, l);
    }
    // 偏りなく: 鍵を順に1件ずつ取って N 件まで
    const picked: Array<{ key: string; u: Usage }> = [];
    for (let round = 0; picked.length < N && round < PER_KEY; round++) for (const [key, l] of perKey) { if (l[round] && picked.length < N) picked.push({ key, u: l[round] }); }
    console.log(`竹内さんの AIX の送信: 鍵 ${perKey.size}・選んだ ${picked.length}件`);

    type Res = { key: string; at: string; skipped?: string; anatomy?: Record<string, unknown> | null; deskPick?: string | null; deskSame?: boolean | null };
    const results: Res[] = [];
    const work = async ({ key, u }: { key: string; u: Usage }): Promise<Res> => {
      const at = u.sent_at ?? u.created_at;
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", u.conversation_id).lt("created_at", at).order("created_at", { ascending: false }).limit(12);
      const msgs = ((data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse();
      const cut = cutBeforeApplicationMaterial(msgs);
      if (cut.cutAt != null && cut.kept.length < msgs.length) return { key, at, skipped: "申込の書類より後" };
      const names = addressNamesOf(msgs.filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
      const lastStaff = msgs.map((m) => m.sender !== "customer").lastIndexOf(true);
      // 11/03 夜 指揮役 (a)(b): 時刻を付ける（#4＝スタッフの続き・#7＝40分前の質問への答えを、直前の発言に結び付けていた）
      const hm = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16);
      const lines = msgs.map((m, i) => `[${hm(m.created_at)}] ${m.sender === "customer" && i > lastStaff ? "★" : ""}${m.sender === "customer" ? "お客様" : "こちら"}: ${maskForLlm(m.text ?? "", names).replace(/\s+/g, " ").slice(0, 220)}`);
      const lastCust = [...msgs].reverse().find((m) => m.sender === "customer");
      const prevStaff = lastCust ? [...msgs].reverse().find((m) => m.sender !== "customer" && Date.parse(m.created_at) < Date.parse(lastCust.created_at)) : undefined;
      const atMs = Date.parse(at);
      const bindNote = !lastCust ? "" : (atMs - Date.parse(lastCust.created_at) <= 120_000 && prevStaff && Date.parse(lastCust.created_at) - Date.parse(prevStaff.created_at) <= 5 * 60_000)
        ? "（注: AIX はお客様の直前の発言の2分以内で、その前の5分以内にスタッフが送り続けていた＝スタッフの続きの可能性が高い）"
        : (atMs - Date.parse(lastCust.created_at) >= 30 * 60_000 ? "（注: 直前のお客様の発言から30分以上たっている＝前の発言への答えの可能性）" : "");
      if (lines.some((l) => applicationMaterialReason(l) || piiValueSignal(l))) return { key, at, skipped: "個人の値" };
      const turnText = msgs.filter((m, i) => m.sender === "customer" && i > lastStaff).map((m) => m.text ?? "").join("\n");
      const sit = maskForLlm(await situationText(u.conversation_id, at, null, turnText), names);
      const conv = lines.join("\n");
      const pairs = (AIX_PAIRS[buttonOfKey(key)] ?? []).map((b) => Object.keys(cards).find((k) => buttonOfKey(k) === b)).filter((x): x is string => !!x);
      const cands = [key, ...pairs].filter((k) => !!cards[k]);
      // ② 読み解き（竹内さんが押した鍵を伝えて「なぜ」を読む）
      const anatomy = await deepseekJson(ANATOMY_SYS, `${sit}\n\n【会話（★が今の番のお客様の発言）】\n${conv}\n\n【竹内さんが押した AIX】[${hm(at)}] ${key}（${pressedLabel(key)}）${bindNote}\n\n【担当の札】\n${cands.map((k) => cards[k]?.text ?? "").join("\n\n")}`, 900);
      // ③ 統括の札で選ばせる（答えを伏せて）＝竹内さんと同じか
      const shuffled = [...cands].sort();
      const c = await deepseekJson(AIX_COMMANDER_SYSTEM, commanderUserText({ situationLine: sit.replace(/^【状況のまとめ（この番の時点の記録だけ）】/, ""), conversation: conv, cards: shuffled.map((k) => ({ key: k, text: cards[k]?.text ?? "" })) }));
      const a = parseCommanderAnswer(c, shuffled);
      return { key, at, anatomy, deskPick: a.pick, deskSame: a.pick ? topicKey(a.pick) === topicKey(key) : false };
    };
    for (let i = 0; i < picked.length; i += 5) {
      if (cost.usd > MAX_USD) { console.log(`費用の上限 $${MAX_USD} で止める（${i}件まで）`); break; }
      results.push(...await Promise.all(picked.slice(i, i + 5).map(work)));
      if (i % 25 === 0) console.log(`  ${Math.min(i + 5, picked.length)}/${picked.length} $${cost.usd.toFixed(3)}`);
    }
    const done = results.filter((r) => !r.skipped && r.anatomy);
    const same = done.filter((r) => r.deskSame).length;
    mkdirSync(OUT, { recursive: true });
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    writeFileSync(join(OUT, `${day}.json`), JSON.stringify(results, null, 1));
    // 鍵ごとの「見分けの軸」の候補（読み解きの axis を集める・札に足す前に人が読む）
    const axesByKey = new Map<string, string[]>();
    for (const r of done) { const ax = String(r.anatomy?.axis ?? "").trim(); if (ax) axesByKey.set(r.key, [...(axesByKey.get(r.key) ?? []), ax]); }
    // ④ 竹内さんに見てもらう10件: 札が竹内さんと違った番を先に・薄い札の鍵を次に
    const review = [...done].sort((a, b) => Number(!!a.deskSame) - Number(!!b.deskSame) || (cards[a.key]?.owner ?? 0) - (cards[b.key]?.owner ?? 0)).slice(0, 10);
    const md = [
      `# 竹内さんの AIX の読み解き（${day}・DeepSeek の下読み）`, "",
      `読み解いた ${done.length}件（外した ${results.length - done.length}: 申込の書類より後・個人の値・失敗）・統括の札で選ばせて竹内さんと同じ ${same}/${done.length}`, "",
      "## 竹内さんに見てもらう10件（札が竹内さんと違った番・札の薄い鍵を先に）", "",
      ...review.flatMap((r, i) => [
        `### ${i + 1}. ${r.key}（${cards[r.key]?.button ?? ""}${cards[r.key]?.picker ? ` → ${cards[r.key]!.picker}` : ""}）・${r.at.slice(0, 10)}・札の答え ${r.deskPick ?? "なし"}${r.deskSame ? "（同じ）" : "（違う）"}`,
        `- 場面: ${String(r.anatomy?.scene ?? "")}${r.anatomy?.answered ? `（答えた発言: ${String(r.anatomy.answered)}）` : ""}`,
        `- なぜこの AIX か: ${String(r.anatomy?.why_this ?? "")}`,
        `- 選ばなかった候補: ${(Array.isArray(r.anatomy?.why_not) ? (r.anatomy!.why_not as Array<{ key?: string; why?: string }>) : []).map((w) => `${w.key}＝${w.why}`).join("／") || "なし"}`,
        `- 返信でなく AIX の理由: ${String(r.anatomy?.why_aix ?? "")}`,
        `- 見分けの軸の案: ${String(r.anatomy?.axis ?? "")}`,
        `- 確認: この読み解きは竹内さんの考えと合っていますか（○／×・× の時は正しい理由）`, "",
      ]),
      "## 鍵ごとの見分けの軸の案（札に足す前に読む）", "",
      ...[...axesByKey].map(([k, ax]) => `- ${k}: ${[...new Set(ax)].slice(0, 4).join("／")}`),
    ].join("\n");
    writeFileSync(join(OUT, `${day}.md`), md);
    console.log(`\n読み解き ${done.length}件・札で竹内さんと同じ ${same}/${done.length}\n書いた: ${join(OUT, `${day}.md`)}・.json`);
    console.log(`費用: DeepSeek ${cost.calls}回 $${cost.usd.toFixed(3)}（失敗 ${cost.fail}）／Claude 0回`);
  } finally { await h.finish(); }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
})();
