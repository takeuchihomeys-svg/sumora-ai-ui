// 最初の段階（first_reply / hearing / condition_hearing / property_search）で、ブレインが AIX を出していない件を目で分ける（読み取りのみ）
//
// 2026-09-23 課題③: audit-brain-funnel.ts で「最初の段階では 23件中10件（43.5%）でブレインが AIX を出していない
//   （スタッフはその後 物件送付・条件ヒアリング・物件確認した を押した）」と分かった。
//   ブレインには正しい「なし」がある（物件送付直後の反応待ち／これから物件を送る予告だけ／物件の無い一般の費用質問）ので、
//   「なし」が正しかった件と、出すべきだった件を **実物で** 分ける。
//
// 【出す物】
//   A. 最初の段階の brain_decision_logs 全件（actual の有無を問わず）: suggested_action の分布・decision_source・analysis_mode
//   B. suggested_action が空の全件: digest（q＝お客様の発言・dir＝返信の方向・aix）＋お客様の最後の発言＋
//      その後スタッフが押した AIX（actual_aix_type か aix_usage_logs の次の押下）＋押すまでの時間＋スタッフの次の送信
//   C. suggested_action がある件: 提案 vs 押した AIX
//   D. 実送信側: 会話ごとにスタッフが **最初に** 押した AIX の分布（全体／成約側／押した時の status が最初の段階）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-first-move.ts [DAYS=120]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const FIRST = ["first_reply", "hearing", "condition_hearing", "property_search"];
const WON_STATUSES = ["closed_won", "applying", "screening", "application", "contract", "approved"];
/** 出力に電話番号・URL を残さない（本名は digest 側で既にマスク済み。本文は短く切る） */
const mask = (s: string | null | undefined, n = 90) =>
  (s ?? "").replace(/\s+/g, " ").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "***-****").replace(/https?:\/\/\S+/g, "[URL]").slice(0, n);
const hours = (a: string | null | undefined, b: string | null | undefined) =>
  a && b ? ((new Date(b).getTime() - new Date(a).getTime()) / 3600_000).toFixed(1) : "—";

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

type Digest = { intent?: string | null; q?: string[]; cond?: string | null; aix?: string | null; dir?: string | null; sig?: string | null; shift?: string | null } | null;
type Log = {
  id: string; conversation_id: string; created_at: string; suggested_action: string | null; decision_source: string | null; analysis_mode: string | null;
  analyzed_msg_ts: string | null; digest: Digest; scene_evidence: string | null; actual_aix_type: string | null; actual_at: string | null; conversation_status: string | null;
  suggested_next_steps: unknown;
};
type Aix = { conversation_id: string; aix_type: string | null; created_at: string; conversation_status: string | null };

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const [logs, aix, convs] = await Promise.all([
    all<Log>((a, b) => sb.from("brain_decision_logs")
      .select("id, conversation_id, created_at, suggested_action, decision_source, analysis_mode, analyzed_msg_ts, digest, scene_evidence, actual_aix_type, actual_at, conversation_status, suggested_next_steps")
      .gte("created_at", since).in("conversation_status", FIRST).order("created_at").range(a, b)),
    all<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, conversation_status").gte("created_at", since).order("created_at").range(a, b)),
    all<{ id: string; status: string | null; customer_name: string | null }>((a, b) => sb.from("conversations").select("id, status, customer_name").range(a, b)),
  ]);
  const wonIds = new Set(convs.filter((c) => WON_STATUSES.includes(c.status ?? "")).map((c) => c.id));
  const nameOf = new Map(convs.map((c) => [c.id, c.customer_name ?? ""]));
  const aixByConv = new Map<string, Aix[]>();
  for (const l of aix) { const a = aixByConv.get(l.conversation_id) ?? []; a.push(l); aixByConv.set(l.conversation_id, a); }

  // ── A. 分布 ─────────────────────────────────────────────
  console.log(`=== A. 最初の段階（${FIRST.join("/")}）の brain_decision_logs ${logs.length}件（${days}日）===`);
  const count = (key: (l: Log) => string) => {
    const m = new Map<string, number>(); for (const l of logs) m.set(key(l), (m.get(key(l)) ?? 0) + 1);
    return [...m].sort((x, y) => y[1] - x[1]);
  };
  console.log("   suggested_action:"); for (const [k, n] of count((l) => (l.suggested_action ?? "").trim() || "(空)")) console.log(`      ${k.padEnd(26)} ${String(n).padStart(4)}（${pct(n, logs.length)}）`);
  console.log("   status:"); for (const [k, n] of count((l) => l.conversation_status ?? "?")) console.log(`      ${k.padEnd(26)} ${String(n).padStart(4)}`);
  const empties = logs.filter((l) => !(l.suggested_action ?? "").trim());
  const cnt2 = (key: (l: Log) => string) => { const m = new Map<string, number>(); for (const l of empties) m.set(key(l), (m.get(key(l)) ?? 0) + 1); return [...m].sort((x, y) => y[1] - x[1]); };
  console.log(`   空の ${empties.length}件の decision_source:`); for (const [k, n] of cnt2((l) => l.decision_source ?? "(null)")) console.log(`      ${k.padEnd(26)} ${String(n).padStart(4)}`);
  console.log(`   空の ${empties.length}件の analysis_mode:`); for (const [k, n] of cnt2((l) => l.analysis_mode ?? "(null)")) console.log(`      ${k.padEnd(26)} ${String(n).padStart(4)}`);
  console.log(`   空の ${empties.length}件の digest.aix:`); for (const [k, n] of cnt2((l) => l.digest?.aix ?? "(null)")) console.log(`      ${k.padEnd(26)} ${String(n).padStart(4)}`);

  // ── B. 空の全件を目で読む ─────────────────────────────────
  console.log(`\n=== B. suggested_action が空の ${empties.length}件（古い→新しい）===`);
  let i = 0;
  for (const l of empties) {
    i++;
    const name = nameOf.get(l.conversation_id) ?? "";
    const at = l.analyzed_msg_ts ?? l.created_at;
    // お客様の最後の発言（分析が見た発言）と、その後のスタッフの最初の送信
    const [{ data: cust }, { data: staffNext }] = await Promise.all([
      sb.from("messages").select("text, created_at, sender").eq("conversation_id", l.conversation_id).lte("created_at", at).order("created_at", { ascending: false }).limit(3),
      sb.from("messages").select("text, created_at, is_aix_generated").eq("conversation_id", l.conversation_id).eq("sender", "staff").gt("created_at", at).order("created_at", { ascending: true }).limit(1),
    ]);
    const custRows = (cust ?? []) as Array<{ text: string | null; created_at: string; sender: string }>;
    const lastCust = custRows.find((m) => m.sender === "customer");
    const prevStaff = custRows.find((m) => m.sender === "staff");
    const next = (staffNext ?? [])[0] as { text: string | null; created_at: string; is_aix_generated: boolean | null } | undefined;
    // 押した AIX: actual_aix_type（cron が対にした物）か、無ければ aix_usage_logs で分析後に最初に押した物
    const later = (aixByConv.get(l.conversation_id) ?? []).filter((x) => x.created_at > l.created_at);
    const pressed = l.actual_aix_type ? { t: l.actual_aix_type, at: l.actual_at } : later[0] ? { t: `${later[0].aix_type}(usage_logs)`, at: later[0].created_at } : null;
    const hide = (s: string) => (name ? s.split(name).join("〇〇") : s);
    console.log(`\n#${i} ${l.created_at.slice(0, 16)} status=${l.conversation_status} mode=${l.analysis_mode ?? "-"} src=${l.decision_source ?? "-"} ${wonIds.has(l.conversation_id) ? "【成約側】" : ""} conv=${l.conversation_id.slice(0, 8)}`);
    console.log(`   digest: intent=${l.digest?.intent ?? "-"} / aix=${l.digest?.aix ?? "-"} / cond=${mask(l.digest?.cond, 60)}`);
    console.log(`   q(お客様の発言): ${hide(mask((l.digest?.q ?? []).join(" ／ "), 160))}`);
    console.log(`   dir(返信の方向): ${hide(mask(l.digest?.dir, 160))}`);
    if (l.scene_evidence) console.log(`   scene: ${hide(mask(l.scene_evidence, 140))}`);
    console.log(`   直前スタッフ: ${prevStaff ? hide(mask(prevStaff.text, 90)) : "(なし)"}`);
    console.log(`   お客様の実文: ${lastCust ? hide(mask(lastCust.text, 140)) : "(なし)"}`);
    console.log(`   → 押した AIX: ${pressed ? `${pressed.t}  ${hours(at, pressed.at)}時間後` : "(なし)"}`);
    console.log(`   → スタッフの次の送信${next?.is_aix_generated ? "(AIX)" : ""}: ${next ? `${hide(mask(next.text, 120))}  ${hours(at, next.created_at)}時間後` : "(なし)"}`);
  }

  // ── C. 提案あり: 提案 vs 押した ─────────────────────────
  console.log(`\n=== C. suggested_action がある ${logs.length - empties.length}件: 提案 → 押した AIX ===`);
  const pairs = new Map<string, number>();
  for (const l of logs) {
    const s = (l.suggested_action ?? "").trim(); if (!s) continue;
    const later = (aixByConv.get(l.conversation_id) ?? []).filter((x) => x.created_at > l.created_at);
    const a = l.actual_aix_type ?? (later[0]?.aix_type ? `${later[0].aix_type}*` : "(押さず)");
    const k = `${s} → ${a}`; pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...pairs].sort((x, y) => y[1] - x[1])) console.log(`   ${k.padEnd(56)} ${String(n).padStart(3)}`);
  console.log("   （* は actual が無く aix_usage_logs で分析後に最初に押した物）");

  // ── D. 実送信側: 会話ごとにスタッフが最初に押した AIX ─────────
  console.log(`\n=== D. 会話ごとにスタッフが最初に押した AIX（aix_usage_logs・${days}日）===`);
  const firstOf = new Map<string, Aix>();
  for (const l of aix) if (l.aix_type && !firstOf.has(l.conversation_id)) firstOf.set(l.conversation_id, l);
  const dist = (rows: Aix[], label: string) => {
    const m = new Map<string, number>(); for (const r of rows) m.set(r.aix_type ?? "?", (m.get(r.aix_type ?? "?") ?? 0) + 1);
    console.log(`   【${label}】${rows.length}会話`);
    for (const [k, n] of [...m].sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`      ${k.padEnd(26)} ${String(n).padStart(4)}（${pct(n, rows.length)}）`);
  };
  const firsts = [...firstOf.values()];
  dist(firsts, "全体");
  dist(firsts.filter((r) => wonIds.has(r.conversation_id)), "成約側（申込以降まで進んだ会話）");
  dist(firsts.filter((r) => FIRST.includes(r.conversation_status ?? "")), "押した時の status が最初の段階");
  dist(firsts.filter((r) => FIRST.includes(r.conversation_status ?? "") && wonIds.has(r.conversation_id)), "押した時の status が最初の段階 × 成約側");

  // ── E. 空の件で AIX要対応（aix_action_items）が立ったか ─────────
  //   ブレインの初回ガード（guard:first_contact）は action を null にする代わりに first_contact_pickup=property_send を残し、
  //   aix-action-items.syncAixActionItem がそれを AIX要対応にする。brain_decision_logs.suggested_action には残らないので、
  //   「空」のうち実際には AIX要対応が立っていた件をここで分ける
  console.log(`\n=== E. 空の ${empties.length}件: 分析から48時間以内に AIX要対応（aix_action_items）が立ったか ===`);
  const emptyConvIds = [...new Set(empties.map((l) => l.conversation_id))];
  const items = await all<{ conversation_id: string; action: string | null; status: string | null; created_at: string; brain_analyzed_msg_ts: string | null }>(
    (a, b) => sb.from("aix_action_items").select("conversation_id, action, status, created_at, brain_analyzed_msg_ts").in("conversation_id", emptyConvIds).order("created_at").range(a, b));
  let withItem = 0;
  empties.forEach((l, idx) => {
    const t0 = new Date(l.created_at).getTime();
    const near = items.filter((it) => it.conversation_id === l.conversation_id && Math.abs(new Date(it.created_at).getTime() - t0) <= 48 * 3600_000);
    if (near.length) withItem++;
    console.log(`   #${idx + 1} status=${(l.conversation_status ?? "").padEnd(17)} ${near.length ? near.map((it) => `${it.action}(${it.status}・${hours(l.created_at, it.created_at)}h)`).join(" / ") : "(要対応なし)"}`);
  });
  console.log(`   要対応が立った ${withItem}件 ／ 立たなかった ${empties.length - withItem}件`);

  // ── F. 初回ガード（guard:first_contact）の全件を場面で割る ─────────
  //   ブレインの初回ガード（brain-core analyzeConversation「初回例外」）は、スタッフの送信が1件も無い会話で
  //   全項目の分析（mode=full）の時だけ action を null にする。今回の発言の層（fresh・mode=incremental）はガードを通らない。
  //   → 同じ初回でも「全項目の分析の行」は空・「1分後の今回の発言の層の行」は AIX あり、になる。ここで場面別に何が起きたかを並べる
  console.log(`\n=== F. 初回ガード（guard:first_contact）の全件（全 status・${days}日）を場面で割る ===`);
  const guardRows = await all<Log>((a, b) => sb.from("brain_decision_logs")
    .select("id, conversation_id, created_at, suggested_action, decision_source, analysis_mode, analyzed_msg_ts, digest, scene_evidence, actual_aix_type, actual_at, conversation_status, suggested_next_steps")
    .gte("created_at", since).eq("decision_source", "guard:first_contact").order("created_at").range(a, b));
  const allLogs = await all<{ conversation_id: string; created_at: string; suggested_action: string | null; decision_source: string | null; analysis_mode: string | null }>(
    (a, b) => sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, decision_source, analysis_mode").gte("created_at", since).order("created_at").range(a, b));
  const { isConditionFormMessage } = await import("../app/lib/reply-context");
  // 2026-09-23 課題③: 直した後の first_contact_pickup（純関数）を実物の scene_evidence に当てて「要対応が立つ見込み」を出す。
  //   旧規則は 条件フォーム（or LLM の property_send/property_search＝記録に無いので条件フォームで近似）→ property_send だけ。
  //   新規則はそれに 物件の画像／URL の指名（S1 property_nomination・image/url）→ property_check_result を足す
  const { resolveFirstContactPickup } = await import("../app/lib/first-contact-pickup");
  type Scene = "条件フォーム" | "物件画像" | "物件URL" | "文だけ";
  const sceneRows = new Map<Scene, Array<{ conv: string; nextRun: string; item: string; pressed: string; lag: string; staffFirst: string; oldPick: string; newPick: string }>>();
  const seenConv = new Set<string>();
  for (const g of guardRows) {
    if (seenConv.has(g.conversation_id)) continue; // 同じ会話の連投は1件に
    seenConv.add(g.conversation_id);
    if (g.conversation_id.startsWith("dd34f5b0")) continue; // YUMA（テスト）
    const at = g.analyzed_msg_ts ?? g.created_at;
    const { data: cust } = await sb.from("messages").select("text, sender, created_at").eq("conversation_id", g.conversation_id).lte("created_at", at).order("created_at", { ascending: false }).limit(5);
    const custTexts = ((cust ?? []) as Array<{ text: string | null; sender: string }>).filter((m) => m.sender === "customer").map((m) => m.text ?? "");
    const joined = custTexts.join("\n");
    const scene: Scene = custTexts.some((t) => isConditionFormMessage(t)) ? "条件フォーム" : /^\[画像\]/.test(custTexts[0] ?? "") || custTexts.some((t) => /^\[画像\]/.test(t)) ? "物件画像" : /https?:\/\//.test(joined) ? "物件URL" : "文だけ";
    const t0 = new Date(g.created_at).getTime();
    const nextRun = allLogs.find((r) => r.conversation_id === g.conversation_id && r.created_at > g.created_at && new Date(r.created_at).getTime() - t0 <= 10 * 60_000 && (r.suggested_action ?? "").trim());
    const { data: it } = await sb.from("aix_action_items").select("action, status, created_at").eq("conversation_id", g.conversation_id).gte("created_at", g.created_at).order("created_at").limit(1);
    const item = (it ?? [])[0] as { action: string; status: string; created_at: string } | undefined;
    const later = (aixByConv.get(g.conversation_id) ?? []).filter((x) => x.created_at > g.created_at);
    const { data: sf } = await sb.from("messages").select("text, created_at").eq("conversation_id", g.conversation_id).eq("sender", "staff").gt("created_at", at).order("created_at").limit(1);
    const staffFirst = ((sf ?? [])[0] as { text: string | null; created_at: string } | undefined);
    const sfText = staffFirst?.text ?? "";
    const sfKind = !staffFirst ? "(未返信)" : /ピックアップ|お探し|お送りさせて頂きます/.test(sfText) && !/募集状況/.test(sfText) ? "ピックアップ宣言" : /募集状況|確認させて/.test(sfText) ? "募集状況確認の宣言" : /条件|エリア.*お送り|お聞かせ/.test(sfText) ? "条件のお願い" : "その他";
    // 直す前後の first_contact_pickup（純関数）。scene_evidence は brain_decision_logs の JSON（compact 形）をそのまま渡す
    let sceneJson: { scene?: string; reason?: string; property_by?: string | null } | null = null;
    try { sceneJson = g.scene_evidence ? JSON.parse(g.scene_evidence) : null; } catch { sceneJson = null; }
    const custForm = custTexts.some((t) => isConditionFormMessage(t));
    const oldPick = custForm ? "property_send" : "なし";
    const newPick = resolveFirstContactPickup({ finalAix: null, custSentConditionForm: custForm, sceneEvidence: sceneJson }) ?? "なし";
    const row = {
      conv: g.conversation_id.slice(0, 8),
      nextRun: nextRun ? `${nextRun.suggested_action}(${nextRun.analysis_mode}/${nextRun.decision_source}・${hours(g.created_at, nextRun.created_at)}h)` : "なし",
      item: item && new Date(item.created_at).getTime() - t0 <= 2 * 3600_000 ? `${item.action}(${hours(g.created_at, item.created_at)}h)` : "なし",
      pressed: later[0] ? `${later[0].aix_type}` : "(押さず)",
      lag: later[0] ? hours(at, later[0].created_at) : "—",
      staffFirst: `${sfKind}${staffFirst ? `(${hours(at, staffFirst.created_at)}h)` : ""}`,
      oldPick, newPick,
    };
    const arr = sceneRows.get(scene) ?? []; arr.push(row); sceneRows.set(scene, arr);
  }
  for (const [scene, rows] of sceneRows) {
    console.log(`\n   【${scene}】${rows.length}会話`);
    for (const r of rows) console.log(`      ${r.conv} 次の分析=${r.nextRun.padEnd(52)} 要対応=${r.item.padEnd(30)} 押した=${r.pressed.padEnd(24)} ${String(r.lag).padStart(6)}h  最初の返信=${r.staffFirst.padEnd(24)} ガードの一手 旧=${r.oldPick.padEnd(14)} → 新=${r.newPick}${r.oldPick !== r.newPick ? "  ★変わる" : ""}`);
    const cnt = (f: (r: typeof rows[number]) => string) => { const m = new Map<string, number>(); for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1); return [...m].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(" ／ "); };
    console.log(`      押した AIX: ${cnt((r) => r.pressed)}`);
    console.log(`      最初の返信: ${cnt((r) => r.staffFirst.replace(/\(.*\)$/, ""))}`);
    console.log(`      要対応が2時間以内に立った: ${rows.filter((r) => r.item !== "なし").length}／${rows.length}`);
    console.log(`      ガードの一手（純関数）旧: ${cnt((r) => r.oldPick)} ／ 新: ${cnt((r) => r.newPick)} ／ 変わる ${rows.filter((r) => r.oldPick !== r.newPick).length}件`);
  }
  {
    const all = [...sceneRows.values()].flat();
    const changed = all.filter((r) => r.oldPick !== r.newPick);
    console.log(`\n   ▶ 直す前後（初回ガード ${all.length}会話・純関数を実物の scene_evidence に当てた見込み）: 「なし」 旧 ${all.filter((r) => r.oldPick === "なし").length}件 → 新 ${all.filter((r) => r.newPick === "なし").length}件 ／ 変わる ${changed.length}件`);
    for (const r of changed) console.log(`      ${r.conv} 新=${r.newPick}  押した=${r.pressed}  最初の返信=${r.staffFirst}  ← 業者DM・既存入居者なら誤り`);
  }

  // ── G. 実送信側: 真の初回の返信（ai_reply_examples.conversation_state=first_reply）の中身 ────
  console.log(`\n=== G. 実送信の初回返信（ai_reply_examples state=first_reply・${days}日）の中身 ===`);
  const ex = await all<{ customer_message: string | null; sent_reply: string | null; aix_action: string | null; conversation_id: string | null }>(
    (a, b) => sb.from("ai_reply_examples").select("customer_message, sent_reply, aix_action, conversation_id").gte("created_at", since).eq("conversation_state", "first_reply").range(a, b));
  const usable = ex.filter((e) => (e.sent_reply ?? "").trim());
  const kinds = new Map<string, { n: number; won: number }>();
  for (const e of usable) {
    const s = e.sent_reply ?? "", c = e.customer_message ?? "";
    const custScene = isConditionFormMessage(c) ? "条件フォーム" : /^\[画像\]/.test(c) ? "物件画像" : /https?:\/\//.test(c) ? "物件URL" : "文だけ";
    const k = /募集状況|確認させて頂きます|確認させていただきます/.test(s) ? "募集状況確認" : /ピックアップ/.test(s) ? "ピックアップ宣言" : /お聞かせ|お送り頂けましたら|お送りいただけましたら|ご条件/.test(s) ? "条件のお願い" : "その他";
    const key = `${custScene.padEnd(6)} → ${k}`;
    const v = kinds.get(key) ?? { n: 0, won: 0 }; v.n++; if (wonIds.has(e.conversation_id ?? "")) v.won++; kinds.set(key, v);
  }
  console.log(`   ${usable.length}件（お客様の場面 → スタッフの初回返信の中身。括弧は成約側）`);
  for (const [k, v] of [...kinds].sort((x, y) => y[1].n - x[1].n)) console.log(`      ${k.padEnd(28)} ${String(v.n).padStart(4)}（${pct(v.n, usable.length)}・成約側 ${v.won}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
