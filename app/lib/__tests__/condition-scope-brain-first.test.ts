// app/lib/__tests__/condition-scope-brain-first.test.ts — 2026-10-13 条件の範囲はブレインの欄だけで決める（ブレインの使い残し 6）
//   実行: npx tsx app/lib/__tests__/condition-scope-brain-first.test.ts
import { resolveConditionChangeScope, resolveScopeForBundle, preBrainMayWriteRegistered, conditionScopeBrainFirst } from "../condition-change-scope";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const on = {}; const off = { CONDITION_SCOPE_BRAIN_FIRST: "off" };

t("既定はブレインの欄だけ", conditionScopeBrainFirst(on) && !conditionScopeBrainFirst(off));
const r1 = resolveConditionChangeScope({ text: "今回だけ1階も見たいです", brainScope: "temporary", env: on });
t("ブレインの temporary をそのまま", r1.scope === "temporary" && r1.by === "brain");
const r2 = resolveConditionChangeScope({ text: "ちなみに旭区、都島区方面で同じような条件でお部屋はありますか？", brainScope: "permanent", env: on });
t("ブレインの permanent をそのまま（文の語は見ない）", r2.scope === "permanent" && r2.by === "brain");
const r3 = resolveConditionChangeScope({ text: "見積もりお願いします", brainScope: "none", env: on });
t("条件でない（none）", r3.scope === "none" && r3.by === "brain");
const r4 = resolveConditionChangeScope({ text: "今回だけ1階も見たいです", brainScope: null, env: on });
t("ブレインの欄が無い時は旧の文の語", r4.scope === "temporary" && r4.by === "text_temporary");
const r5 = resolveConditionChangeScope({ text: "今回だけ1階も見たいです", brainScope: "permanent", env: off });
t("戻す（off）と文の語が先", r5.scope === "temporary" && r5.by === "text_temporary");
t("ブレインより先の経路の安全の線は残す（今回だけの語で登録を先に書かない）", preBrainMayWriteRegistered("今回だけ1階も", { desired_area: "梅田" }).ok === false);
const b = resolveScopeForBundle({ text: "やっぱり1Kに変えてください", brainScope: "permanent" });
t("束でも最後の発言はブレインの欄（既定）", b.decision.by === "brain" && b.decision.scope === "permanent");
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
