// scripts/audit-aix-miss-causes.ts — スタッフが AIX を押した番でブレインが外した番を原因で分ける（読むだけ・LLM なし・費用 0）
//
// 2026-10-28 作業員1（統括の設計図「AIX のブレイン: スタッフが押した番の多くでブレインが外した」の中身）:
//   対象＝見張り line_watch_turns の直近 N 日で、スタッフが返事のまとまり（burst）で AIX を押し、ブレインが同じ AIX でなかった番
//   （aix_verdict が other／unexpected・申込以降・重複・YUMA は外す）。
//   分け（上から順に当てる）:
//     ⑤ 材料が届いていない: ブレインがこの番を読んでいない（ブレインの記録が無い・読んだ発言の時刻が番より前）
//     ④ スタッフだけが知る事: お客様の言葉はお礼・了承・到着だけで、スタッフが 20分以上後に押した（現地・電話・管理会社の結果など LINE の外の事で動いた）／内覧後の挨拶
//     ③ 約束かその場か: ブレインは返信で、下書きがスタッフの AIX と同じ種類の約束（確認・見積・ピックアップ）＝作業員5の2択（TWO_CHOICE_PROMISE_OR_NOW）で拾える
//     ① 返信と AIX の取り違え: ブレインは返信（約束でもない）・スタッフは AIX
//     ② AIX の種類違い: ブレインも AIX・種類が違う（どの種類→どの種類）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-miss-causes.ts [--days=30] [--list]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const LIST = process.argv.includes("--list");

const JA: Record<string, string> = {
  property_check_result: "物件確認した", acknowledge_check: "確認した", property_recommendation: "物件オススメ", property_send: "物件ピックアップ",
  property_search: "物件を探す", zenryoku_support: "全力サポート", estimate_sheet: "見積書送る", cost_breakdown: "初期費用について", cost_explain: "初期費用を説明",
  viewing_invite: "内覧調整", meeting_place: "待ち合わせ場所", greeting_viewing: "内覧後の挨拶", application_push: "申込へ", phone_call: "電話",
  condition_hearing: "条件ヒアリング", guarantor_info: "保証会社",
};
const ja = (k: string | null | undefined) => (k ? JA[k] ?? k : "返信");
const FAMILY: Record<string, string> = {
  property_check_result: "確認", acknowledge_check: "確認", guarantor_info: "確認",
  estimate_sheet: "見積", cost_breakdown: "見積", cost_explain: "見積",
  property_send: "物件", property_recommendation: "物件", property_search: "物件", zenryoku_support: "物件",
};
// 下書きの約束（作業員5 audit-conductor-states.ts と同じ網）
const PROMISE: Array<[string, RegExp]> = [
  ["見積", /(?:御見積|お見積|見積書)[^。！\n]{0,20}(?:作成|お送り|させて頂きます)/],
  ["確認", /(?:確認させて頂きます|確認させていただきます|確認致します|確認いたします|確認(?:出来|でき)次第)/],
  ["物件", /ピックアップ[^。！\n]{0,20}(?:お送り|させて頂きます|させていただきます)|(?:新着|お部屋)[^。！\n]{0,15}出次第[^。！\n]{0,10}お送り/],
];
const ACK_ONLY = /^(?:[\s　]*(?:ありがと(?:う|ございます|ございました)?|了解(?:です|しました)?|わかりました|分かりました|承知(?:しました|致しました|いたしました)?|かしこまりました|よろしく(?:お願い(?:します|いたします|致します))?|宜しくお願い(?:します|致します|いたします)|お願いします|お願いいたします|はい|つきました|着きました|到着しました|今向かってます|向かいます|\[スタンプ\]|[！!。、～ー〜…😊🙇‍♀️♂️🙏✨]+)[\s　]*)+$/u;

type Row = {
  id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; scene_key: string | null;
  brain_action: string | null; brain_reply_mode: string | null; brain_at: string | null; brain_analyzed_msg_ts: string | null;
  draft_first: string | null; draft_last: string | null; staff_aix: Array<{ at: string; aix_type: string; burst: boolean }> | null;
  verdict_detail: Record<string, unknown> | null; decision_id: string | null;
};

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let f = 0; ; f += 1000) {
    let r: any = null;
    for (let t = 0; t < 4; t++) {
      r = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, scene_key, brain_action, brain_reply_mode, brain_at, brain_analyzed_msg_ts, draft_first, draft_last, staff_aix, verdict_detail, decision_id")
        .gte("customer_turn_at", since).order("id").range(f, f + 999);
      if (!r.error) break; await new Promise((s) => setTimeout(s, 3000));
    }
    if (r.error) throw new Error(r.error.message);
    rows.push(...((r.data ?? []) as Row[]));
    if ((r.data ?? []).length < 1000) break;
  }
  const pressedAll = rows.filter((t) => !isTestConversation(t.conversation_id) && (t.verdict_detail ?? {}).reason !== "duplicate_turn"
    && (t.staff_aix ?? []).some((a) => a.burst));
  const target = pressedAll.filter((t) => {
    const d = t.verdict_detail ?? {};
    return (d.aix_verdict === "other" || d.aix_verdict === "unexpected") && d.reason !== "same_via_mapping" && d.reason !== "out_of_scope";
  });

  // お客様の言葉（番の中）
  const custText = new Map<number, string>();
  for (const t of target) {
    const { data } = await sb.from("messages").select("text").eq("conversation_id", t.conversation_id).eq("sender", "customer")
      .gte("created_at", t.customer_turn_at).lte("created_at", t.customer_last_at ?? t.customer_turn_at).order("created_at");
    custText.set(t.id, ((data ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n"));
  }

  // ブレインの記録の要約（ds＝決めた出所・la＝後で果たす AIX・tc＝本質の数 r返信 p約束 a AIX）。下書きが無い番（生成の前にスタッフが動いた 等）でも約束かが分かる
  const digest = new Map<number, { ds: string; la: string; tc: string; dir: string }>();
  for (const t of target) {
    if (!t.decision_id) continue;
    const { data } = await sb.from("brain_decision_logs").select("digest").eq("id", t.decision_id).maybeSingle();
    const g = ((data as { digest?: Record<string, unknown> } | null)?.digest ?? {}) as Record<string, unknown>;
    digest.set(t.id, { ds: String(g.ds ?? ""), la: String(g.la ?? ""), tc: String(g.tc ?? ""), dir: String(g.dir ?? "") });
  }
  let noDraft = 0;
  type Out = { t: Row; cause: string; staff: string; brain: string; why: string };
  const out: Out[] = [];
  for (const t of target) {
    const press = (t.staff_aix ?? []).filter((a) => a.burst);
    const staff = press[0]?.aix_type ?? "";
    const brainAix = t.brain_reply_mode === "aix" ? (t.brain_action || null) : null;
    const draft = (t.draft_last && !t.draft_last.startsWith("__") ? t.draft_last : t.draft_first) ?? "";
    const g = digest.get(t.id) ?? { ds: "", la: "", tc: "", dir: "" };
    const cust = custText.get(t.id) ?? "";
    const lastAt = Date.parse(t.customer_last_at ?? t.customer_turn_at);
    const lagMin = (Date.parse(press[0]?.at ?? "") - lastAt) / 60000;
    const read = t.brain_analyzed_msg_ts ? Date.parse(t.brain_analyzed_msg_ts) >= lastAt - 1000 : !!t.brain_at && Date.parse(t.brain_at) >= lastAt;
    let cause: string, why = "";
    if (!t.brain_reply_mode || !read) { cause = "⑤材料が届いていない"; why = !t.brain_reply_mode ? "ブレインの記録なし" : "今の発言を読む前の判断"; }
    else if (staff === "greeting_viewing" || (ACK_ONLY.test(cust.trim() || "x") && lagMin >= 20)) { cause = "④スタッフだけが知る事"; why = staff === "greeting_viewing" ? "内覧後の挨拶" : `お礼・了承だけ→${Math.round(lagMin)}分後に押した`; }
    else if (!brainAix) {
      const fam = FAMILY[staff];
      if (!draft.trim()) noDraft++;
      // ブレインの約束の種類: 記録の la（後で果たす AIX）→ ds の two_stage_promise(kind) → 下書きの文
      const dsKind = /two_stage_promise\((check|check_question|brought_both|brought|estimate|pickup|pickup_unless_ack|search_split)/.exec(g.ds)?.[1] ?? "";
      const famFromDs = /^check|^brought/.test(dsKind) ? "確認" : dsKind === "estimate" ? "見積" : /^pickup|search_split/.test(dsKind) ? "物件" : "";
      const promisedP = /p[1-9]/.test(g.tc);
      const brainFam = FAMILY[g.la] ?? famFromDs ?? "";
      const draftFam = PROMISE.find(([, re]) => re.test(draft))?.[0] ?? "";
      const dirFam = !promisedP ? "" : /見積/.test(g.dir) && fam === "見積" ? "見積" : /確認/.test(g.dir) ? "確認" : /見積/.test(g.dir) ? "見積" : /ピックアップ|お部屋[^。]{0,20}お送り/.test(g.dir) ? "物件" : "";
      const pf = brainFam || draftFam || dirFam;
      const both = dsKind === "brought_both" && (fam === "確認" || fam === "見積");
      if (pf && (pf === fam || both)) { cause = "③約束かその場か"; why = `ブレインは${pf}${both ? "＋見積" : ""}の約束${draft.trim() ? "" : "（下書きなし）"}`; }
      else if (pf || promisedP) { cause = "①返信と AIX の取り違え"; why = `ブレインは別の約束（${pf || "種類不明"}）`; }
      else { cause = "①返信と AIX の取り違え"; why = draft.trim() ? "下書きは答え・受け" : "答え・受け（下書きなし）"; }
    } else { cause = "②AIX の種類違い"; why = `${ja(brainAix)}→${ja(staff)}`; }
    out.push({ t, cause, staff, brain: brainAix ?? "返信", why });
  }

  const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");
  console.log(`# スタッフが AIX を押した番でブレインが外した番の原因（直近${DAYS}日・見張り）`);
  console.log(`スタッフが AIX を押した番 ${pressedAll.length}・ブレインが外した番 ${target.length}（同じ系統への写しで合った番・申込以降は除く）\n`);
  const causes = ["①返信と AIX の取り違え", "②AIX の種類違い", "③約束かその場か", "④スタッフだけが知る事", "⑤材料が届いていない"];
  console.log(`（ブレインが返信で下書きが見張りに無い番 ${noDraft}）
`);
  console.log("| 原因 | 番 | 割合 |\n|---|---|---|");
  for (const c of causes) { const n = out.filter((o) => o.cause === c).length; console.log(`| ${c} | ${n} | ${pct(n, out.length)} |`); }

  const tally = (xs: Out[], key: (o: Out) => string) => { const m = new Map<string, Out[]>(); for (const o of xs) { const k = key(o); m.set(k, [...(m.get(k) ?? []), o]); } return [...m].sort((a, b) => b[1].length - a[1].length); };
  console.log("\n## ① 返信と AIX の取り違え: スタッフが押した AIX");
  for (const [k, v] of tally(out.filter((o) => o.cause.startsWith("①")), (o) => ja(o.staff))) console.log(`- ${k}: ${v.length}（${tally(v, (o) => o.t.scene_key ?? "").slice(0, 3).map(([s, w]) => `${s} ${w.length}`).join("・")}）`);
  console.log("\n## ② AIX の種類違い（ブレイン→スタッフ）");
  for (const [k, v] of tally(out.filter((o) => o.cause.startsWith("②")), (o) => o.why)) console.log(`- ${k}: ${v.length}（#${v.slice(0, 6).map((o) => o.t.id).join(" #")}）`);
  console.log("\n## ③ 約束かその場か（作業員5の2択で拾える）");
  for (const [k, v] of tally(out.filter((o) => o.cause.startsWith("③")), (o) => `${o.why}→${ja(o.staff)}`)) console.log(`- ${k}: ${v.length}`);
  console.log("\n## ④ スタッフだけが知る事");
  for (const [k, v] of tally(out.filter((o) => o.cause.startsWith("④")), (o) => ja(o.staff))) console.log(`- ${k}: ${v.length}`);
  console.log("\n## ⑤ 材料が届いていない");
  for (const [k, v] of tally(out.filter((o) => o.cause.startsWith("⑤")), (o) => o.why)) console.log(`- ${k}: ${v.length}`);
  if (LIST) {
    console.log("\n## 番ごと");
    for (const o of out) console.log(`- #${o.t.id} ${o.t.customer_turn_at.slice(5, 16)} ${o.t.scene_key} ${o.cause} ブレイン=${ja(o.brain === "返信" ? null : o.brain)} スタッフ=${ja(o.staff)}（${o.why}）｜客: ${(custText.get(o.t.id) ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
  }
  process.exit(0);
})();
