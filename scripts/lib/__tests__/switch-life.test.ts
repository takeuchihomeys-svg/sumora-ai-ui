// npx tsx scripts/lib/__tests__/switch-life.test.ts
// 2026-11-27 作業員L（台帳 #816 スイッチの一生の台帳）
import assert from "node:assert/strict";
import { lifeStateOf, lifeRowOf, lifeMorningLine, lifeLedgerTitle, ownerPurposeFromCode, lifeLine, STALE_DAYS, type LifeIn } from "../switch-life";
import { nightZeroCostSteps } from "../exam-night-jobs";

const now = "2026-11-27T12:00:00.000Z";
const base: LifeIn = { sw: "X_LINE", code: "off", where: ["app/lib/x.ts"], prod: null, staged: null, revert: false, cron: false, notExam: null, ledger: null, codeOwner: "作業員L", codePurpose: "x", mark: "x_line", dictN: 0, effN: 0, ragN: 0, lastExam: null, reachedN: null, kbIds: [] };
const L = (o: Partial<NonNullable<LifeIn["ledger"]>>) => ({ id: 1, title: "t", stage: "built_off", owner: "作業員A", switch_default: "off", exam_result: null, exam_labels: null, kb_ids: null, ...o });

// 状態
assert.equal(lifeStateOf({ ...base, ledger: L({ stage: "dropped" }) }), "退役");
assert.equal(lifeStateOf({ ...base, ledger: L({ next_step: "凍結（悪化1）" }) }), "凍結");
assert.equal(lifeStateOf({ ...base, revert: true }), "戻し口");
assert.equal(lifeStateOf({ ...base, prod: "on" }), "on", "コードは off でも本番 env で on");
assert.equal(lifeStateOf({ ...base, staged: "all" }), "on");
assert.equal(lifeStateOf({ ...base, staged: "yuma" }), "段階");
assert.equal(lifeStateOf({ ...base, prod: "shadow" }), "記録だけ");
assert.equal(lifeStateOf(base), "off");

// 候補: 試験が 14日無い off だけ。戻し口・cron・凍結・測らない・新しい物は外す
assert.equal(lifeRowOf(base, now).candidate, "試す", "印がある＝届く組を積める");
assert.equal(lifeRowOf({ ...base, mark: null }, now).candidate, "印が先");
assert.equal(lifeRowOf({ ...base, lastExam: { label: "l-x-1120", at: "2026-11-20T00:00:00Z" } }, now).candidate, null, "7日前に試験");
assert.equal(lifeRowOf({ ...base, lastExam: { label: "l-x-1101", at: "2026-11-01T00:00:00Z" }, reachedN: 0 }, now).candidate, "退役", "on の回で一度も届かない");
assert.equal(lifeRowOf({ ...base, lastExam: { label: "l-x-1101", at: "2026-11-01T00:00:00Z" }, reachedN: 0, ragN: 2 }, now).candidate, "試す", "RAG の候補で届いた");
assert.equal(lifeRowOf({ ...base, cron: true }, now).candidate, null);
assert.equal(lifeRowOf({ ...base, revert: true }, now).candidate, null);
assert.equal(lifeRowOf({ ...base, notExam: "cron の物" }, now).candidate, null);
assert.equal(lifeRowOf({ ...base, ledger: L({ next_step: "凍結" }) }, now).candidate, null);
assert.equal(lifeRowOf({ ...base, madeAt: "2026-11-27T05:00:00Z" }, now).candidate, null, "作って 14日未満");
assert.equal(lifeRowOf({ ...base, madeAt: `2026-11-${String(27 - STALE_DAYS).padStart(2, "0")}T00:00:00Z` }, now).candidate, "試す");
assert.equal(lifeRowOf({ ...base, where: [], seen: "none" }, now).candidate, "退役", "どこにも無い");
assert.equal(lifeRowOf({ ...base, where: [], seen: "app" }, now).candidate, null, "読み方が分からない物は退役にしない");
assert.equal(lifeRowOf({ ...base, where: [], seen: "scripts" }, now).candidate, null);
// 持ち主: 台帳 → コードのコメント
assert.equal(lifeRowOf({ ...base, ledger: L({ owner: "作業員A" }) }, now).owner, "作業員A");
assert.equal(lifeRowOf({ ...base, codeOwner: null }, now).owner, null);

// 朝の1行・台帳の題
const rows = [lifeRowOf(base, now), lifeRowOf({ ...base, sw: "Y", mark: null, codeOwner: null }, now), lifeRowOf({ ...base, sw: "Z", where: [], seen: "none" }, now), lifeRowOf({ ...base, sw: "W", prod: "on" }, now)];
assert.equal(lifeMorningLine(rows), "スイッチの一生（#816）: 既定 off 3・試す候補 1・退役の候補 1・持ち主の無い物 1・印が先 1");
assert.equal(lifeLedgerTitle(rows[0]), "【スイッチの一生】X_LINE: 試験が一度も無い off → 試す（届く組を積む）");
assert.ok(lifeLine(rows[0]).includes("印 x_line") && lifeLine(rows[0]).includes("台帳なし"));

// コメントから持ち主と日
const src = ["// 2026-11-20 作業員A（台帳 #1）: 入居の時期の1行", "if (stagedOn(\"X_LINE\")) {}"].join("\n");
assert.deepEqual(ownerPurposeFromCode(src, "X_LINE"), { owner: "作業員A", purpose: "入居の時期の1行", madeAt: "2026-11-20T00:00:00.000Z" });
assert.deepEqual(ownerPurposeFromCode("if (x) {}", "X_LINE"), { owner: null, purpose: null });

assert.ok(nightZeroCostSteps("x.json").some((x) => x.args[0] === "scripts/switch-life.ts" && x.args.includes("--write")), "晩の費用0の仕事");
console.log("switch-life: ok");
