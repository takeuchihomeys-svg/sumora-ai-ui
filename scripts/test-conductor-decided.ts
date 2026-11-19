// scripts/test-conductor-decided.ts — 統括が決めた事の台帳・必ず届ける欄・届いたかの確かめ・段階の語の寄せ（app/lib/conductor-decided.ts）のテスト（LLM/DB なし・費用0・作業員22）
// 実行: npx tsx scripts/test-conductor-decided.ts
import assert from "node:assert/strict";
import { conductorDecidedOn, buildDecidedLedger, decidedDigest, decidedNote, deliveryCheck, deliveryDigest, unifyStage, STAGE_FROM_FOCUS, STAGE_FROM_CHECKPOINT, MUST_DELIVER, DELIVER_FIELDS } from "../app/lib/conductor-decided";
import { buildHandoff, handoffNote, type ConductorRole } from "../app/lib/conductor-handoff";
import { stageAt } from "../app/lib/conductor-focus";
import { STAGE_LABEL, type CustomerStage } from "../app/lib/customer-state";
import { buildConductorBrief } from "../app/lib/conductor-brief";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

const meta: Record<string, unknown> = {
  action: null, checkpoint_stage: "viewing", main_point: "内覧の最終の時刻に答える",
  conductor_focus: { focus: "answer", why: "最終時刻を聞かれた", keepPromise: true },
  turn_contract: { asks: [{ quote: "何時まで内覧できますか", kind: "question", route: "reply", basis: "company_fact", answer: "18時まで" }, { quote: "駐車場の空き", kind: "question", route: "promise", answer: "駐車場の空きを確認させて頂きます" }] },
  latent_read: { part: { property: null, point: "仕事終わりに見たい" }, feeling: { what: "時間が合うか不安", strength: "mid" }, want: "平日の夜に内覧", fact: "電話は19時まで" },
  near_opinion: "似た番で竹内さんは時刻を先に答えた",
  our_side_note: "前に駐車場の確認を約束していない",
  appeal_timing: { kind: "viewing", level: "suggest", reason: "内覧の話の最中" },
};

t("既定 off", () => { assert.equal(conductorDecidedOn({}), false); assert.equal(conductorDecidedOn({ CONDUCTOR_DECIDED: "on" }), true); });

t("決めた事の台帳: 種類・対象・理由・いつ の1つの型（重点・継続の約束・段階・依頼ごとの道・約束・誘導先・こちら側）", () => {
  const l = buildDecidedLedger(meta, { openPromises: ["見積書をお送りする"] });
  const kinds = l.map((x) => x.kind);
  for (const k of ["focus", "keep", "stage", "ask", "promise", "lead", "our_side"]) assert.ok(kinds.includes(k as never), k);
  assert.deepEqual(l.find((x) => x.kind === "stage"), { kind: "stage", target: "viewing_arranging", reason: "checkpoint_stage:viewing", when: "now", from: "checkpoint_stage" });
  assert.deepEqual(l.filter((x) => x.kind === "promise").map((x) => x.when), ["later", "open"]);
  assert.ok(l.every((x) => x.target && x.from));
  assert.equal(decidedDigest(l), "f1p2s1l1k1o1a2");
  assert.deepEqual(buildDecidedLedger({}), []);
});

t("段階の語は customer-state に寄せる（stageAt の全部・checkpoint_stage の全部・CustomerStage そのまま）", () => {
  for (const [k, v] of Object.entries(STAGE_FROM_FOCUS)) { assert.ok(v in STAGE_LABEL, k); assert.equal(unifyStage(k), v); }
  for (const [k, v] of Object.entries(STAGE_FROM_CHECKPOINT)) { assert.ok(v in STAGE_LABEL, k); assert.equal(unifyStage(k), v); }
  for (const k of Object.keys(STAGE_LABEL)) assert.equal(unifyStage(k), k as CustomerStage);
  // stageAt が返す言葉は全部 STAGE_FROM_FOCUS にある
  const outs = new Set([stageAt([]), stageAt([{ sender: "staff", text: "x", created_at: "" }]), ...["application_push", "meeting_place", "viewing_invite", "estimate_sheet", "property_send"].map((a) => stageAt([{ sender: "staff", text: "", created_at: "", aixType: a }]))]);
  for (const s of outs) assert.ok(s in STAGE_FROM_FOCUS, s);
  assert.equal(unifyStage("zzz"), null);
});

t("必ず届ける欄: 役ごとの表は DELIVER_FIELDS の中だけ・どの欄にもなぜ", () => {
  for (const [role, keys] of Object.entries(MUST_DELIVER)) for (const k of keys) assert.ok(DELIVER_FIELDS[k], `${role} ${k}`);
  for (const f of Object.values(DELIVER_FIELDS)) assert.ok(f.why.length > 10, f.key);
});

t("今の Handoff だけでは届かない欄が分かる（頭6字の確かめでなく欄ごと）・決めた事のブロックを足すと全部届く", () => {
  const roles: ConductorRole[] = ["aix_desk", "compose", "writer", "check", "deep", "second"];
  for (const role of roles) {
    const h = handoffNote(buildHandoff({ to: role, meta }));
    const before = deliveryCheck(meta, role, h);
    const after = deliveryCheck(meta, role, `${h}\n${decidedNote(meta, role)}`);
    assert.ok(Object.values(before).includes("missing"), `${role} 今の Handoff で ${deliveryDigest(before)}`);
    assert.ok(Object.values(after).every((v) => v === "ok"), `${role} ${deliveryDigest(after)}`);
    console.log(`   ${role}: 今 ${deliveryDigest(before)} → 足すと ${deliveryDigest(after)}`);
  }
  assert.equal(deliveryCheck({}, "writer", "").focus, "no_value");
  assert.equal(decidedNote({}, "writer"), "");
});

t("統括の指示書に決めた事の台帳が入る（照らし合わせのまだ果たしていない約束も）", () => {
  const b = buildConductorBrief({ ...meta, conductor_brief_inputs: { ledger: { open: [{ kind: "our_promise_unkept", what: "見積書をお送りする", at: "", overdue: false }], keptPromises: [] } } });
  assert.ok(b.decided.some((x) => x.kind === "promise" && x.when === "open" && x.target === "見積書をお送りする"));
  assert.ok(b.decided.some((x) => x.kind === "focus" && x.target === "answer"));
});
console.log(`\n${n} 件 ok`);
