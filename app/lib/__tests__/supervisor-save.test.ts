// app/lib/__tests__/supervisor-save.test.ts
// 2026-11-14 竹内さん「なんでここ統括がちゃんと学習する絶対ルールなのに連携できていないのか」
//   「これで統括が俺の代わりにブレインとなり判断や改善更新できるようにしていく」
//
// 実測で分かった **連携できていなかった理由（3つ）**:
//   ① `learn_supervisor_log` だけ **RLS を有効**にしていた
//      → Service Role キーが無いと書けない。ローカルには無いので必ず失敗（実測: 挿入が
//        `new row violates row-level security policy` で弾かれた）。
//      既存の表（automation_commands 等）は DISABLE で動いている＝食い違い。
//   ② 保存が**投げっぱなし**（`void (async () => {})()`）で、失敗を握り潰していた
//      → Vercel は応答を返した時点で打ち切るので、書き込みが消えることがある。
//   ③ 保存されている行に **meeting（議題・根拠）が入っていない**（keys: created_at, scope, verdict...）
//      → 「場面の根拠を学習したか」を後から確かめられない。
//
// 直した事（このテストで固定する）:
//   ① RLS を DISABLE にそろえる（migrate-schema と init の両方・表が在っても直す）
//   ② 保存を**待つ**（`saveSupervisorForBundle` を API が await する・結果を束に載せる）
//   ③ 保存する行を `toLogRow` が作る（meeting / actions / delta を含む）
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/supervisor-save.test.ts
import fs from "node:fs";
import path from "node:path";
import { toLogRow } from "../learn-supervisor-db";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");

console.log("■ ① RLS を無効にそろえた（書けない原因）");
{
  const mig = read("app/api/migrate-schema/route.ts");
  const init = read("app/api/learn-supervisor-init/route.ts");
  ok("migrate-schema が DISABLE する", /ALTER TABLE learn_supervisor_log DISABLE ROW LEVEL SECURITY/.test(mig));
  ok("  ⚠ ENABLE より後ろにある（最後に効く）",
    mig.indexOf("ALTER TABLE learn_supervisor_log DISABLE ROW LEVEL SECURITY") >
    mig.indexOf("ALTER TABLE learn_supervisor_log ENABLE ROW LEVEL SECURITY"));
  ok("init も DISABLE する（表が既にあっても直す）", /ALTER TABLE learn_supervisor_log DISABLE ROW LEVEL SECURITY/.test(init));
  ok("  表が在る時も RLS を直す（旧は『在れば何もしない』で永久に直らなかった）",
    /if \(!probe\.error\)[\s\S]{0,900}?DISABLE ROW LEVEL SECURITY/.test(init));
}

console.log("\n■ ② 保存を待つ（投げっぱなしをやめた）");
{
  const brain = read("app/lib/human-learn-brain.ts");
  const api = read("app/api/human-learn-profile/route.ts");
  ok("saveSupervisorForBundle がある", /export async function saveSupervisorForBundle/.test(brain));
  ok("  ⚠ 投げっぱなし（void (async）で保存していない",
    !/void \(async \(\) => \{[\s\S]{0,400}?saveSupervisorLog/.test(brain));
  ok("API が await して待つ", /await saveSupervisorForBundle\(bundle\)/.test(api));
  ok("  結果を束に載せる（残ったか分かる）", /supervisor_saved/.test(api));
  ok("  保存の結果を返す（ok / error を持つ）", /all: \{ ok: boolean/.test(brain) || /out\.all = \{ ok: false/.test(brain));
  ok("  失敗しても束は返す（現場を止めない）", /try \{[\s\S]{0,300}?saveSupervisorForBundle\(bundle\)[\s\S]{0,300}?\} catch/.test(api));
}

console.log("\n■ ③ 保存する行に議題・根拠・次にやる事が入る");
{
  const adv = superviseLearn({
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [], mode_counts: { normal: 200 }, site_counts: { realpro: 200 }, with_ops: 120,
    site: "all", shot_rows: 190,
  });
  const row = toLogRow("all", adv, { rows: 200, next_n: 40, bundle_at: "2026-11-14T09:00:00.000Z" });
  ok("verdict が入る", typeof row.verdict === "string" && row.verdict.length > 0, row.verdict);
  ok("headline が入る", typeof row.headline === "string", row.headline);
  ok("  ⚠ meeting（議題・根拠）が入る", !!row.meeting, row.meeting);
  ok("  ⚠ actions（次にやる事）が入る", Array.isArray(row.actions), row.actions);
  ok("coverage / weak_n が入る", typeof row.coverage === "number" && typeof row.weak_n === "number");
  ok("bundle_at（どの束か）が入る", row.bundle_at === "2026-11-14T09:00:00.000Z", row.bundle_at);
  ok("scope が入る", row.scope === "all");
  // 個人情報を入れない（キーだけ確かめる）
  const keys = Object.keys(row).join(",");
  ok("  ⚠ 名前・電話・住所・入力値の列が無い", !/customer_name|phone|address|input_value|email/i.test(keys), keys);
}

console.log("\n■ ④ 同じ束を二重に数えない（bundle_at で判定）");
{
  const db = read("app/lib/learn-supervisor-db.ts");
  ok("同じ bundle_at なら足さない", /eq\("bundle_at", row\.bundle_at\)/.test(db));
  ok("  表が無い時は静かに諦める（学習は止めない）", /no_table/.test(db));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
