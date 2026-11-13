// 自信が無い時に統括が人に回す段（2026-11-13 作業員5・CONDUCTOR_STAFF_CHECK=shadow|on・既定 off）
// 実行: npx tsx app/lib/__tests__/conductor-staff-check.test.ts
import { staffCheckMode, decideStaffCheck, staffCheckNote, staffCheckWriterLine, staffCheckOf, STAFF_CHECK_REASONS, DEPTH_REASON_TO_STAFF_CHECK, REF_HANDOFF_NAMES } from "../conductor-staff-check";
import { shadowAutoGate } from "../shadow-auto-gate";
import { readFileSync } from "node:fs";
import { join } from "node:path";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(extra)); } };

t("既定 off・shadow と on だけ", staffCheckMode({}) === "off" && staffCheckMode({ CONDUCTOR_STAFF_CHECK: "shadow" }) === "shadow" && staffCheckMode({ CONDUCTOR_STAFF_CHECK: " ON " }) === "on" && staffCheckMode({ CONDUCTOR_STAFF_CHECK: "yes" }) === "off");

// 10911（点検役・名前は伏せた）: お客様が物件の画像を送った番で、画像の物件名が空・入口の統括の自信 low
const r10911 = decideStaffCheck({ intakeConfidence: "low", turnHasImage: true, currentProperty: "", asks: [{ route: "reply", basis: "material" }], depthReason: "持ち込み" });
t("10911: 画像の物件名が空 → ref_unresolved・深さの札（持ち込み）と合う", r10911?.reasons.join() === "ref_unresolved" && r10911.gate === "low_confidence" && r10911.depth_match === true, r10911);
// 12105（点検役）: 送った側の取り違え＝指す物の確かさ（作業員16 の ref_resolve）が low
const r12105 = decideStaffCheck({ intakeConfidence: "low", ref: { resolved: true, sure: "low" }, currentProperty: "〇〇", depthReason: "指す物が複数" });
t("12105: ref_resolve の確かさ low → ref_unresolved（ref がある時は画像の決まった形を見ない）", r12105?.reasons.join() === "ref_unresolved" && r12105.depth_match, r12105);
// 作業員16 の ref_resolve.handoff（ref_needs_name／ref_needs_room）: 統括役 11/13 の決めで自信に関係なく回す・他の理由は low の時だけ
const rh = decideStaffCheck({ intakeConfidence: "high", ref: { handoff: ["ref_needs_room", "x", "ref_needs_room"] }, asks: [{ route: "reply", basis: "general" }] });
t("ref_resolve.handoff は自信が high でも ref_unresolved・中身は ref_detail・推測の理由は足さない", rh?.reasons.join() === "ref_unresolved" && rh.ref_detail?.join() === "ref_needs_room", rh);
const rh2 = decideStaffCheck({ intakeConfidence: "low", ref: { handoff: ["ref_needs_name"] }, asks: [{ route: "reply", basis: "general" }] });
t("low の時は他の理由も並ぶ", rh2?.reasons.join() === "ref_unresolved,answer_guess_only" && rh2.ref_detail?.join() === "ref_needs_name", rh2);
t("REF_HANDOFF_NAMES は作業員16 の REF_HANDOFF_REASONS と同じ名前", REF_HANDOFF_NAMES.join() === "ref_needs_name,ref_needs_room");
t("ref が解けている番は回さない", decideStaffCheck({ intakeConfidence: "low", ref: { resolved: true, sure: "high" }, turnHasImage: true, currentProperty: "" }) === null);

t("自信が low でない番は理由があっても回さない（今まで通り）",
  decideStaffCheck({ intakeConfidence: "mid", turnHasImage: true, currentProperty: "" }) === null && decideStaffCheck({ intakeConfidence: null, turnHasImage: true }) === null);
t("自信が low でも理由が無い番は回さない", decideStaffCheck({ intakeConfidence: "low", asks: [{ route: "reply", basis: "material" }], currentProperty: "〇〇" }) === null);

// 答えの出所が推測だけ
t("返信の依頼が全部 general/judgement → answer_guess_only", decideStaffCheck({ intakeConfidence: "low", asks: [{ route: "reply", basis: "general" }, { route: "reply", basis: "judgement" }, { route: "promise", basis: null }] })?.reasons.join() === "answer_guess_only");
t("1つでも資料・会話の出所があれば推測だけではない", decideStaffCheck({ intakeConfidence: "low", asks: [{ route: "reply", basis: "general" }, { route: "reply", basis: "conversation" }] }) === null);
t("latent_five の段が全部 guess → answer_guess_only", decideStaffCheck({ intakeConfidence: "low", latentFive: { object: { src: "guess" }, concern: { src: "guess" }, reason: { guess: true } } })?.reasons.join() === "answer_guess_only");
t("latent_five に事実の出所が1つあれば回さない", decideStaffCheck({ intakeConfidence: "low", latentFive: { object: { src: "customer_words" }, concern: { src: "guess" }, reason: null } }) === null);

// 読みの候補が割れた
t("候補2つ・選べていない → reading_split", decideStaffCheck({ intakeConfidence: "low", readCandidates: { turn: "short_unclear", options: ["物件を送ってほしい", "空きを知りたい"], chosen: null, by: null } })?.reasons.join() === "reading_split");
t("候補2つ・決めた根拠が事実でない → reading_split", decideStaffCheck({ intakeConfidence: "low", readCandidates: { turn: "ack_only", options: ["a", "b"], chosen: 0, by: "なんとなく" } })?.reasons.join() === "reading_split");
t("候補2つ・直前の送信で1つに決まった → 回さない", decideStaffCheck({ intakeConfidence: "low", readCandidates: { turn: "ack_only", options: ["a", "b"], chosen: 1, by: "直前の送信がピックアップの約束" } }) === null);
t("turn=none・候補1つは回さない", decideStaffCheck({ intakeConfidence: "low", readCandidates: { turn: "none", options: ["a", "b"], chosen: null } }) === null
  && decideStaffCheck({ intakeConfidence: "low", readCandidates: { turn: "short_unclear", options: ["a"], chosen: null } }) === null);

// 注記と書き手の1行
const all = decideStaffCheck({ intakeConfidence: "low", turnHasImage: true, currentProperty: null, asks: [{ route: "reply", basis: "general" }], readCandidates: { turn: "brought_property", options: ["a", "b"], chosen: null } })!;
t("理由は決まった順に3つ", all.reasons.join() === STAFF_CHECK_REASONS.join(), all);
t("注記は1行・理由の日本語", !all.note.includes("\n") && all.note.includes("指す物が解けない・答えの出所が推測だけ・読みの候補が割れた") && staffCheckNote(["reading_split"]).includes("読みの候補が割れた"));
const wl = staffCheckWriterLine(all);
t("書き手の1行: 言い切らない・推測で物件名を書かない・お客様と呼ばない", wl.startsWith("【この番は言い切らない】") && /推測で書かない/.test(wl) && !/お客様/.test(wl) && staffCheckWriterLine(null) === "", wl);
t("深さの札の対応は人へ回す理由の中だけ", Object.values(DEPTH_REASON_TO_STAFF_CHECK).every((r) => (STAFF_CHECK_REASONS as readonly string[]).includes(String(r))));

// 最終チェックの控えから読む・影の関所の止めた線に入る（人へ回す理由の名前が同じ）
t("staffCheckOf: 一覧の理由だけ・無ければ null", staffCheckOf({ staff_check: { reasons: ["ref_unresolved", "x"], note: "n" } })?.reasons.join() === "ref_unresolved" && staffCheckOf({}) === null && staffCheckOf(null) === null && staffCheckOf({ staff_check: { reasons: ["x"] } }) === null);
const gateBase = { draft: "かしこまりました！！確認させて頂きます！！", draftSrc: "last", convStatus: "active", brainReplyMode: "reply", brainAction: null, groundText: "", groundExtra: true, env: {} };
const g1 = shadowAutoGate({ ...gateBase, finalCheck: { ok: true, issues: [], staff_check: { reasons: ["ref_unresolved"], note: "n" } } });
const g0 = shadowAutoGate({ ...gateBase, finalCheck: { ok: true, issues: [] } });
t("影の関所: staff_check の理由が止めた線に入る・無い控えは今まで通り", g1.lines.includes("ref_unresolved") && !g1.would_send && !g0.lines.includes("ref_unresolved"), { g1: g1.lines, g0: g0.lines });

// 配線
const route = readFileSync(join(__dirname, "..", "..", "api", "generate-reply", "route.ts"), "utf8");
t("配線: off の時は決めない・on の時だけ書き手の1行（brainGuidanceNote の後ろ）", /staffCheckMode\(\) !== "off" && brainMeta \?/.test(route) && /staffCheckMode\(\) === "on" && staffCheckRec && brainGuidanceNote \?/.test(route) && /brainGuidanceNote \+ staffCheckWriterNote, directionNote,/.test(route));
t("配線: 注記は final_check.staff_check（下書きの文には足さない）", /finalCheck\.staff_check = \{ reasons: staffCheckRec\.reasons, note: staffCheckRec\.note/.test(route) && !/finalDraftText\s*\+=?\s*[^;]*staffCheck/.test(route));
const page = readFileSync(join(__dirname, "..", "..", "page.tsx"), "utf8");
t("画面: 注記は下書きの外の帯に出す", /checkResult\?\.staff_check\?\.note && replyDraft\.trim\(\)/.test(page));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
