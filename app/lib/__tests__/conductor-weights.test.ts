// app/lib/__tests__/conductor-weights.test.ts — 合い方の表 → conductor_weights の行
//   実行: npx tsx app/lib/__tests__/conductor-weights.test.ts
import { weightsFromFitTable, weightsUpsertSql } from "../conductor-weights";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const r = weightsFromFitTable({ date: "2026-11-04", rows: [
  { id: "a", scene: "ack", n: 139, few: false, brains: [{ brain: "judge", pct: 63 }, { brain: "compose", pct: 37 }] },
  { id: "b", scene: "rare", n: 8, few: true, brains: [{ brain: "judge", pct: 50 }] },
  { id: "c", scene: "x", n: 30, few: false, brains: [{ brain: "nope", pct: 50 }] },
] });
t("件数が足りる場面だけ・ブレインごとに1行・weight は比率", r.rows.length === 2 && r.rows[0].weight === 0.63 && r.rows[1].brain === "compose" && r.rows[0].n === 139);
t("basis=takeuchi・source=record・decides=false・hit は NULL・answer_kind は *", r.rows.every((x) => x.basis === "takeuchi" && x.source === "record" && x.decides === false && x.hit === null && x.answer_kind === "*"));
t("少ない場面・知らないブレインは外して理由を出す", r.skipped.length === 2 && r.skipped[0].includes("少ない"));
const sql = weightsUpsertSql(r.rows);
t("SQL: 決める側・record 以外の行は上書きしない", sql.includes("WHERE conductor_weights.decides = false AND conductor_weights.source = 'record'") && sql.includes("ON CONFLICT (scene, brain, answer_kind, basis)"));
t("SQL: 引用符を逃がす", weightsUpsertSql([{ ...r.rows[0], scene: "o'k" }]).includes("'o''k'"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
