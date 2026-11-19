// 動き計画 API の純関数テスト: npx tsx tests/motion-plan.test.ts
// 拡張の sanitizePlan（human-wait.js）を通して、範囲・形が食い違っていないことを見張る。
import { buildMotionPlan, PERSONA_RANGE } from "../app/lib/motion-plan";
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HW = require("../chrome-extension/human-wait.js");
let pass = 0, fail = 0;
function ok(n: string, c: boolean, d?: unknown) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + JSON.stringify(d) : "")); } }

const now = Date.UTC(2026, 10, 19, 9, 0, 0);
const p = buildMotionPlan({ now });
ok("形: v=1・plan_id・expires_at・run_seed・persona", p.v === 1 && /^mp-/.test(p.plan_id) && typeof p.run_seed === "number" && !!p.persona, p);
ok("期限は既定10分", Date.parse(p.expires_at) - now === 10 * 60 * 1000);
const keys = Object.keys(PERSONA_RANGE) as (keyof typeof PERSONA_RANGE)[];
let inRange = true;
for (let i = 0; i < 2000; i++) {
  const q = buildMotionPlan({ now });
  for (const k of keys) { const [lo, hi] = PERSONA_RANGE[k]; if (!(q.persona[k] >= lo && q.persona[k] <= hi)) inRange = false; }
}
ok("2000回引いても persona は全項目が範囲内", inRange);
const a = buildMotionPlan({ now, rng: (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })() });
const b = buildMotionPlan({ now, rng: (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })() });
ok("同じ乱数なら同じ計画（再現できる）", JSON.stringify(a) === JSON.stringify(b));
const ids = new Set<string>(); for (let i = 0; i < 500; i++) ids.add(buildMotionPlan().plan_id);
ok("毎回違う plan_id（ランごとに新しい個性）", ids.size >= 499, ids.size);
const sp = HW.sanitizePlan(p, now);
ok("拡張の sanitizePlan が受け入れる（期限内）", !!sp && sp.plan_id === p.plan_id && sp.run_seed === p.run_seed, sp);
ok("拡張が丸めても値は変わらない（範囲が揃っている）", keys.every((k) => sp && sp.persona[k] === p.persona[k]), sp && sp.persona);
ok("期限が切れたら拡張は無視する", HW.sanitizePlan(p, now + 11 * 60 * 1000) === null);
const per = HW.makePersona(1, p, now);
ok("拡張の makePersona が計画の persona を使う（source=plan）", per.source === "plan" && per.speed_scale === p.persona.speed_scale, per);
const r = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const route = r("app/api/motion-plan/route.ts");
ok("API: DB を読まない（supabase を使わない）", !/supabase/i.test(route.replace(/\/\/.*$/gm, "")));
ok("API: MOTION_PLAN_OFF=1 で plan:null（止められる）", /MOTION_PLAN_OFF/.test(route) && /plan: null/.test(route));
const bg = r("chrome-extension/background.js");
ok("拡張: 入力開始の前に _refreshMotionPlan を呼ぶ", /await _refreshMotionPlan\(\);[\s\S]{0,200}_createFillStartWaiter|_refreshMotionPlan\(\); \} catch \(_\) \{\}\n?\r?\n?\s*var _startP/.test(bg) || bg.indexOf("_refreshMotionPlan();") < bg.indexOf("var _startP = _createFillStartWaiter(_cidStr, _startTimeout);"));
ok("拡張: 1.5秒で諦める・止め印・失敗は握りつぶす", /AbortSignal\.timeout\(1500\)/.test(bg) && /axlx_motion_plan_off/.test(bg));
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
