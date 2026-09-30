// 「物件確認した（募集状況）」と「確認した（条件・交渉）」の分かれ目の監査（読み取りのみ・LLM は呼ばない・本文はマスク）
// 2026-09-30 竹内「管理会社の名前は『確認した』から送るようにする。物件確認したじゃなくて。物件確認したと確認したがごっちゃになっている」
//
// ① お客様の質問の話題（管理会社そのもの・保証会社・設備・入居日・ペット・駐車場・空き）ごとに、次のスタッフの動き
//    （物件確認した側のピッカー／確認した側のピッカー／他の AIX／本文だけ／なし）を数える（DAYS 日・グループと YUMA を除く）
// ② スタッフが押した 物件確認した（aix_usage_logs）の直前のお客様の連投に、今のコードの分かれ目（resolveBrainCheckPattern）を当て、
//    押されたボタン（募集状況側／条件側）と合うかを数える
// ③ ブレインの過去の判断（brain_decision_logs・property_check_result）に今のコードを当て直し、ボタンがどう変わるか・
//    スタッフの実際の押下（actual_check_pattern）との一致の前後を並べる。変わった行は全部出す（目で読む）
// 実行: npx tsx --env-file=.env.local scripts/audit-check-button-split.ts   （DAYS=365・SHOW=8）
import { createClient } from "@supabase/supabase-js";
import { detectAixSceneEvidence, AVAILABILITY_URL_RE } from "../app/lib/aix-scene-evidence";
import { detectPropertyCheckPattern } from "../app/lib/aix-taxonomy";
import { resolveBrainCheckPattern } from "../app/lib/brain-aix-feedback";
import { checkPatternTopic } from "../app/lib/aix-pickers";
import { MGMT_COMPANY_Q_RE, MOVEIN_Q_RE } from "../app/lib/scene-patterns";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 365);
const SHOW = Number(process.env.SHOW ?? 8);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/\[画像\][^\n]*/g, "[画像]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
async function page(table: string, cols: string, s: string, tcol = "created_at"): Promise<Row[]> {
  const out: Row[] = [];
  for (let p = 0; p < 400; p++) {
    const { data, error } = await sb.from(table).select(cols).gte(tcol, s).order(tcol).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}

const Q = /[？?]|ですか|ますか|でしょうか|ですかね|教えて|おしえて|知りたい|欲しい|ほしい/;
const TOPICS: Array<{ key: string; label: string; expect: "確認した" | "物件確認した" | "保証会社について"; hit: (t: string) => boolean }> = [
  { key: "mgmt_company", label: "管理会社そのもの（名前・どこ・連絡先）", expect: "確認した", hit: (t) => MGMT_COMPANY_Q_RE.test(t) },
  { key: "guarantor", label: "保証会社（どこ・種類）", expect: "保証会社について", hit: (t) => /保証会社[^。\n]{0,8}(?:どこ|どちら|何|教え|種類)/.test(t) },
  { key: "move_in", label: "入居日", expect: "確認した", hit: (t) => MOVEIN_Q_RE.test(t) && Q.test(t) },
  { key: "pet", label: "ペット可否", expect: "確認した", hit: (t) => /ペット|(?:猫|犬)[^。\n]{0,8}(?:飼|可|OK|大丈夫)/.test(t) && Q.test(t) && !/①|②|【/.test(t) },
  { key: "parking", label: "駐車場", expect: "確認した", hit: (t) => /駐車場|駐輪|バイク置/.test(t) && Q.test(t) && !/①|②|【/.test(t) },
  { key: "equipment", label: "設備", expect: "確認した", hit: (t) => /エアコン|コンロ|ウォシュレット|洗濯機置|ネット無料|設備/.test(t) && Q.test(t) && !/①|②|【/.test(t) },
  { key: "vacancy", label: "空き・募集状況", expect: "物件確認した", hit: (t) => /空(?:き|いて|室)|まだ(?:あり|空|募集|残)|募集(?:中|して|され)|埋ま(?:って|り)/.test(t) && Q.test(t) && !/①|②|【|明日|今日|日程|時間|[0-9０-９]日/.test(t) },
];
const button = (cp: string | null | undefined): "物件確認した" | "確認した" => {
  const t = checkPatternTopic(cp);
  return t === "condition" || cp === "mgmt_availability" ? "確認した" : "物件確認した";
};

async function main() {
  const convs: Row[] = [];
  for (let p = 0; p < 20; p++) { const { data } = await sb.from("conversations").select("id, line_source_type").range(p * 1000, p * 1000 + 999); convs.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  const ok = new Set<string>(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const msgs = (await page("messages", "conversation_id, sender, text, created_at, is_aix_generated", new Date(Date.parse(since) - 3 * 86400e3).toISOString())).filter((m) => ok.has(m.conversation_id));
  const logs = (await page("aix_usage_logs", "conversation_id, aix_type, check_pattern, created_at, sent_at", since)).filter((a) => a.sent_at && ok.has(a.conversation_id));
  const byConv = new Map<string, Row[]>(); for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const logsByConv = new Map<string, Row[]>(); for (const l of logs) { const a = logsByConv.get(l.conversation_id) ?? []; a.push(l); logsByConv.set(l.conversation_id, a); }
  const turnBefore = (cid: string, atMs: number): { text: string; hasImage: boolean; endMs: number } => {
    const list = (byConv.get(cid) ?? []).filter((m) => Date.parse(m.created_at) <= atMs);
    let i = list.length - 1;
    while (i >= 0 && list[i].sender !== "customer") i--;
    if (i < 0 || atMs - Date.parse(list[i].created_at) > 48 * 3600e3) return { text: "", hasImage: false, endMs: 0 };
    const endMs = Date.parse(list[i].created_at);
    const turn: string[] = []; let img = false;
    for (; i >= 0 && list[i].sender === "customer"; i--) { const tx = (list[i].text ?? "").trim(); if (/^\[画像\]/.test(tx)) img = true; else if (tx) turn.unshift(tx); }
    return { text: turn.join("\n"), hasImage: img, endMs };
  };

  // ① 話題 × 次のスタッフの動き
  console.log(`\n══ ① お客様の質問の話題 × 次のスタッフの動き（${DAYS}日・グループと YUMA を除く）`);
  type Cell = { n: number; act: Record<string, number>; ex: string[] };
  const cells = new Map<string, Cell>();
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || Date.parse(m.created_at) < Date.parse(since)) continue;
      if (list[i + 1]?.sender === "customer") continue; // 連投の最後の通だけ
      let j = i; const turn: string[] = [];
      for (; j >= 0 && list[j].sender === "customer"; j--) { const tx = (list[j].text ?? "").trim(); if (tx && !/^\[画像\]/.test(tx)) turn.unshift(tx); }
      const text = turn.join("\n").normalize("NFKC");
      if (!text || text.length > 400) continue;
      const topic = TOPICS.find((t) => t.hit(text));
      if (!topic) continue;
      const t0 = Date.parse(m.created_at);
      let k = i + 1; while (k < list.length && list[k].sender !== "customer") k++;
      const t1 = Math.min(k < list.length ? Date.parse(list[k].created_at) : Infinity, t0 + 48 * 3600e3);
      const presses = (logsByConv.get(cid) ?? []).filter((l) => { const t = Date.parse(l.created_at); return t > t0 && t < t1; });
      const staffText = list.slice(i + 1, k).filter((s) => s.sender === "staff" && Date.parse(s.created_at) < t1);
      const pcr = presses.filter((l) => l.aix_type === "property_check_result");
      const act = pcr.length
        ? [...new Set(pcr.map((l) => `${button(l.check_pattern)}（${l.check_pattern ?? "null"}）`))].join("＋")
        : presses.length ? `他の AIX（${[...new Set(presses.map((l) => l.aix_type))].join("・")}）`
        : staffText.length ? "本文だけ" : "返信なし";
      const c = cells.get(topic.key) ?? { n: 0, act: {}, ex: [] };
      c.n++; c.act[act] = (c.act[act] ?? 0) + 1;
      if (topic.key === "mgmt_company" || c.ex.length < SHOW) c.ex.push(`${m.created_at.slice(5, 10)} ${cid.slice(0, 8)} [${act}] 客「${mask(text).slice(0, 90)}」→ ス「${mask(staffText.map((s) => s.text ?? "").join(" / ")).slice(0, 110)}」`);
      cells.set(topic.key, c);
    }
  }
  for (const t of TOPICS) {
    const c = cells.get(t.key); if (!c) { console.log(`\n■ ${t.label}: 0`); continue; }
    const side = (b: string) => Object.entries(c.act).filter(([k]) => k.startsWith(b + "（") || k.includes("＋" + b)).reduce((a, [, v]) => a + v, 0);
    console.log(`\n■ ${t.label}（竹内さんの定義: ${t.expect}）: ${c.n}件 ／ 物件確認した側 ${side("物件確認した")}・確認した側 ${side("確認した")}`);
    console.log("   " + Object.entries(c.act).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" ／ "));
    for (const e of c.ex) console.log("   ・" + e);
  }

  // ② 押された 物件確認した × 今のコードの分かれ目
  const pcrLogs = logs.filter((l) => l.aix_type === "property_check_result");
  console.log(`\n══ ② スタッフが押した 物件確認した ${pcrLogs.length}件 × 今のコードの分かれ目（直前のお客様の連投に当てる）`);
  const tab: Record<string, number> = {}; const miss: string[] = [];
  for (const l of pcrLogs) {
    const turn = turnBefore(l.conversation_id, Date.parse(l.created_at));
    if (!turn.text && !turn.hasImage) { tab["（直前の発言なし）"] = (tab["（直前の発言なし）"] ?? 0) + 1; continue; }
    const ev = detectAixSceneEvidence({ latestCustomerTurn: turn.text, hasCustomerImage: turn.hasImage, sentPropertyCount: 1 });
    const kind = resolveBrainCheckPattern("property_check_result", ev, null, turn.text, { hasImage: turn.hasImage });
    const predicted = kind ? (kind.ui_button.startsWith("確認した") ? "確認した" : "物件確認した") : "決めない";
    const actual = button(l.check_pattern);
    const key = `押した=${actual} ／ コード=${predicted}`;
    tab[key] = (tab[key] ?? 0) + 1;
    if ((predicted !== "決めない" || actual === "確認した") && predicted !== actual && miss.length < 60) miss.push(`${l.created_at.slice(5, 10)} ${l.conversation_id.slice(0, 8)} 押した=${actual}（${l.check_pattern ?? "null"}） コード=${predicted}（${kind?.check_pattern || "-"}） 客「${mask(turn.text).slice(0, 110)}」${turn.hasImage ? "＋画像" : ""}`);
  }
  for (const [k, v] of Object.entries(tab).sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`);
  console.log("  ─ 合わない行:"); for (const m of miss) console.log("   ・" + m);

  // ③ ブレインの過去の判断の当て直し
  const decs = (await page("brain_decision_logs", "conversation_id, created_at, suggested_action, suggested_check_pattern, decision_source, analyzed_msg_ts, scene_evidence, actual_aix_type, actual_check_pattern", since))
    .filter((d) => d.suggested_action === "property_check_result" && ok.has(d.conversation_id) && d.analyzed_msg_ts);
  console.log(`\n══ ③ ブレインの判断（物件確認した・${decs.length}件）に今のコードを当て直す`);
  // 前＝今回の直しの前の決まり（管理会社そのものの話題なし・空き/持ち込みの「はっきり」なし）を同じ連投に当てた物。後＝今のコード。
  //   画面・AIX要対応の表記は check_pattern が条件側の時だけ「確認した（条件・交渉）」、それ以外は「物件確認した」（前後とも同じ）
  const seen = new Set<string>(); const ch: Record<string, number> = {}; const lines: string[] = [];
  let pressedN = 0, okBefore = 0, okAfter = 0, clearBefore = 0, clearAfter = 0, total = 0;
  const label = (k: { ui_button: string; check_pattern: string } | null) => !k ? "決めない（2つの区別の帯・表記は物件確認した）" : k.ui_button.startsWith("確認した") ? `確認した（${k.check_pattern}）` : k.check_pattern ? `物件確認した（${k.check_pattern}）` : "物件確認した（募集状況）";
  const shown = (k: { ui_button: string } | null) => (k && k.ui_button.startsWith("確認した") ? "確認した" : "物件確認した");
  for (const d of decs) {
    const key = `${d.conversation_id}|${d.analyzed_msg_ts}`; if (seen.has(key)) continue; seen.add(key);
    const turn = turnBefore(d.conversation_id, Date.parse(d.analyzed_msg_ts) + 1000);
    if (!turn.text && !turn.hasImage) continue;
    total++;
    const ev = detectAixSceneEvidence({ latestCustomerTurn: turn.text, hasCustomerImage: turn.hasImage, sentPropertyCount: 1 });
    const sig = /^signal:scene_S(?:2|3|11)/.test(d.decision_source ?? "") || /^rule:procedure/.test(d.decision_source ?? "") ? d.suggested_check_pattern : null;
    const after = resolveBrainCheckPattern("property_check_result", ev, sig, turn.text, { hasImage: turn.hasImage });
    // 前: 管理会社そのもの → 話題なし（null）／空き・持ち込みの「はっきり」→ null
    const before = !after ? null : after.check_pattern === "mgmt_company" ? null : (!after.check_pattern && after.topic === "空き・募集状況") ? null
      : (!after.check_pattern && /管理会社/.test(after.topic)) ? null : after;
    if (before) clearBefore++; if (after) clearAfter++;
    const k2 = `${label(before)} → ${label(after)}`; ch[k2] = (ch[k2] ?? 0) + 1;
    const pressed = d.actual_aix_type === "property_check_result";
    if (pressed) { pressedN++; const act = button(d.actual_check_pattern); if (shown(before) === act) okBefore++; if (shown(after) === act) okAfter++; }
    if (label(before) !== label(after) && (shown(before) !== shown(after) || lines.length < 25)) lines.push(`${d.created_at.slice(5, 10)} ${d.conversation_id.slice(0, 8)} ${label(before)} → ${label(after)}${pressed ? ` ／押した=${button(d.actual_check_pattern)}（${d.actual_check_pattern ?? "null"}）` : d.actual_aix_type ? ` ／押した=${d.actual_aix_type}` : ""} 客「${mask(turn.text).slice(0, 100)}」${turn.hasImage ? "＋画像" : ""}`);
  }
  for (const [k, v] of Object.entries(ch).sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`);
  console.log(`   判断 ${total}件のうち、どちらのボタンかをはっきり書いた帯: 前 ${clearBefore} → 後 ${clearAfter}`);
  console.log(`   スタッフが 物件確認した を押した判断 ${pressedN}件: 表記のボタンと押したボタンの一致 前 ${okBefore} → 後 ${okAfter}`);
  console.log("  ─ 変わる行（ボタンが変わる行は全部・同じボタンではっきり書くようになった行は25件まで）:"); for (const l of lines) console.log("   ・" + l);

  // ④ 「この物件…ですか」の形だけで S1 募集状況に当たる連投（空き・募集の語なし・持ち込みなし）→ 次のスタッフの動き
  console.log(`
══ ④ 場面の証拠が S1（availability_question）で、空き・募集状況の語も持ち込みも無い連投 × 次のスタッフの動き`);
  const s1: Record<string, number> = {}; const s1ex: string[] = []; let s1n = 0;
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || Date.parse(m.created_at) < Date.parse(since) || list[i + 1]?.sender === "customer") continue;
      let j = i; const turn: string[] = []; let img = false;
      for (; j >= 0 && list[j].sender === "customer"; j--) { const tx = (list[j].text ?? "").trim(); if (/^\[画像\]/.test(tx)) img = true; else if (tx) turn.unshift(tx); }
      const text = turn.join("\n"); if (!text || img || text.length > 300) continue;
      const ev = detectAixSceneEvidence({ latestCustomerTurn: text, hasCustomerImage: false, sentPropertyCount: 1 });
      if (ev?.reasonCode !== "availability_question") continue;
      const kind = resolveBrainCheckPattern("property_check_result", ev, null, text, { hasImage: false });
      if (kind && !(kind.ui_button.startsWith("確認した"))) continue; // 空き・持ち込みは対象外
      s1n++;
      const t0 = Date.parse(m.created_at);
      let k = i + 1; while (k < list.length && list[k].sender !== "customer") k++;
      const t1 = Math.min(k < list.length ? Date.parse(list[k].created_at) : Infinity, t0 + 48 * 3600e3);
      const presses = (logsByConv.get(cid) ?? []).filter((l) => { const t = Date.parse(l.created_at); return t > t0 && t < t1; });
      const staffText = list.slice(i + 1, k).filter((x) => x.sender === "staff" && Date.parse(x.created_at) < t1);
      const pcr = presses.filter((l) => l.aix_type === "property_check_result");
      const act = pcr.length ? [...new Set(pcr.map((l) => button(l.check_pattern)))].join("＋") : presses.length ? `他の AIX（${[...new Set(presses.map((l) => l.aix_type))].join("・")}）` : staffText.length ? "本文だけ" : "返信なし";
      const key = `コード=${kind ? `確認した（${kind.check_pattern}）` : "決めない"} ／ スタッフ=${act}`;
      s1[key] = (s1[key] ?? 0) + 1;
      if (!kind && s1ex.length < 45) s1ex.push(`${m.created_at.slice(5, 10)} ${cid.slice(0, 8)} [${act}] 客「${mask(text).slice(0, 100)}」→ ス「${mask(staffText.map((x) => x.text ?? "").join(" / ")).slice(0, 80)}」`);
    }
  }
  console.log(`   ${s1n}件`); for (const [k, v] of Object.entries(s1).sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`);
  console.log("  ─ 決めない の実物:"); for (const e of s1ex) console.log("   ・" + e);
  void detectPropertyCheckPattern; void AVAILABILITY_URL_RE;
}
main().catch((e) => { console.error(e); process.exit(1); });
