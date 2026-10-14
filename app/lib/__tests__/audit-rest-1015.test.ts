// app/lib/__tests__/audit-rest-1015.test.ts — 監査の残り #7 自動の replyHint・#9 ブレインの書き出し・#10 確定・最優先の注記（実行: npx tsx app/lib/__tests__/audit-rest-1015.test.ts）
//   例は監査（scripts/audit-rest-1015.ts）で読んだ実際の番の形を伏せて使う
import { autoReplyHintOf, replyHintBrainEnabled } from "../reply-hint-auto";
import { demoteFixedNote, classifyFixedNoteTriggers, isNewConditionText, fixedNoteBrainEnabled } from "../fixed-content-notes";
import { normalizeBrainOpener, brainOpenerKind, brainOpenerMetaEnabled } from "../opener-rates";
import { toFreshDigest } from "../brain-layers";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };

console.log("#7 自動の replyHint（bg-async と同じ線）");
{
  const a = autoReplyHintOf("なるほど！\nすいません。\n1LDKにしたら2人入居は厳しいでしょうか？\nもし");
  t("短い行3つ以上＝箇条書き", a.kind === "bullet" && a.hint.startsWith("【お客様が列挙した条件・要望"), a);
  const b = autoReplyHintOf("野田阪神からは少し距離ありますかね🤔");
  t("「ありますか」＝条件変更/ピックアップ依頼（誤爆の形・材料に下げる対象）", b.kind === "cond_pickup", b);
  t("初回は作らない", autoReplyHintOf("a\nb\nc", { firstReply: true }).kind === null);
  const c = autoReplyHintOf("今の就職先ですか？？", { lastStaffText: "勤務先名・勤務先所在地・携帯番号をご記入ください" });
  t("申込フォーム説明の直後の短い確認質問", c.kind === "form_question", c);
  t("何も当たらない", autoReplyHintOf("ありがとうございます").kind === null);
  t("既定 on・=off で旧", replyHintBrainEnabled({}) && !replyHintBrainEnabled({ REPLY_HINT_BRAIN: "off" }));
}

console.log("#10 確定・最優先の注記");
{
  const note = "\n【🆕 新条件・追加要望の検出（確定・最優先）】お客様は…\n【返信の型（この要素以外を入れない）】\n①…\n【🚫 解説禁止】…\n【🚫 絶対禁止CTA（フェーズ別パターンより上位）】申込…";
  const d = demoteFixedNote(note, true, {});
  t("本質がブレインの番は見出しを材料に", d.includes("（材料・型の候補 — 中身と向きは【🧭 この番の本質】に従う") && !d.includes("確定・最優先"), d);
  t("型・禁止も候補の言い方に", d.includes("【返信の型の候補（本質に合う時だけ）】") && d.includes("【🚫 避ける形CTA（本質が求める時は除く）】") && d.includes("【🚫 避ける形】"), d);
  t("ブレインの判断が無い番は今まで通り", demoteFixedNote(note, false, {}) === note);
  t("FIXED_NOTE_BRAIN=off で旧", demoteFixedNote(note, true, { FIXED_NOTE_BRAIN: "off" }) === note && !fixedNoteBrainEnabled({ FIXED_NOTE_BRAIN: "off" }));
  const mv = "\n【🏠 入居可能時期の質問（確定・最優先）】…\n【✅ 正しい回答方針（必ず守る）】…\n【🚫 絶対禁止】「確認させていただきます」";
  const dm = demoteFixedNote(mv, true, {});
  t("入居時期の注記も", dm.includes("【✅ 回答方針の候補（本質に合う時だけ）】") && dm.includes("【🚫 避ける形（本質が求める時は除く）】"), dm);
  const bi = "\n\n【🚨 予算・条件指定の在庫質問（確定・最優先）】\n【✅ この質問への正しい返信の型】\n【🔴 絶対NG】「確認してご連絡します」のみ";
  const db = demoteFixedNote(bi, true, {});
  t("在庫質問の注記も", db.includes("【✅ 返信の型の候補（本質に合う時だけ）】") && db.includes("【🔴 避ける形】"), db);
  t("新条件の語（日程の「〜てもいいですか」も当たる＝誤爆の形・30日で竹内さん=ブレインの番）", isNewConditionText("退去可能時期の確認をしてから日程送ってもいいですか") === true);
  t("当たり: 新条件", classifyFixedNoteTriggers("家賃を15万円までにした場合の物件も\nあれば教えていただけませんか？").includes("new_condition"));
  t("当たり: 特定月の入居", classifyFixedNoteTriggers("11月に入居できますか？").includes("move_in_month"));
}

console.log("#9 ブレインの書き出し");
{
  t("そのまま", normalizeBrainOpener("かしこまりました") === "かしこまりました" && normalizeBrainOpener("はい") === "はい");
  t("承知・了解→かしこまりました", normalizeBrainOpener("承知しました") === "かしこまりました");
  t("「なし」→開口語なし", normalizeBrainOpener("なし") === "開口語なし" && normalizeBrainOpener("開口語なし") === "開口語なし");
  t("お礼の書き出し", normalizeBrainOpener("ご条件お送り頂きありがとうございます") === "〇〇頂きありがとうございます");
  t("null・外の値は null", normalizeBrainOpener(null) === null && normalizeBrainOpener("null") === null && normalizeBrainOpener("よろしく") === null);
  t("出口の種類は はい/かしこまりました/なし だけ", brainOpenerKind("はい") === "hai" && brainOpenerKind("かしこまりました") === "kashikomari" && brainOpenerKind("開口語なし") === "none" && brainOpenerKind("お世話になっております") === null && brainOpenerKind(null) === null);
  t("既定 on・=off で旧", brainOpenerMetaEnabled({}) && !brainOpenerMetaEnabled({ BRAIN_OPENER_META: "off" }));
  const dg = toFreshDigest({ reply_opener: "はい", analyzed_msg_ts: null }, null);
  t("判断ログの要点に op", dg.op === "はい", dg);
  t("無い時は欄なし", !("op" in toFreshDigest({ analyzed_msg_ts: null }, null)));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
