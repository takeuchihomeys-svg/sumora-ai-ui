// 前の既定に係の下敷きを入れる（scripts/lib/exam-env-fp.ts underlayOf・envFingerprintOf・defaultEnvOf）
// 実行: npx tsx scripts/lib/__tests__/exam-underlay-base.test.ts（全 PASS で exit 0）
import { underlayOf, envFingerprintOf, defaultEnvOf, type EnvReader } from "../exam-env-fp";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const files: Record<string, string> = { a: JSON.stringify({ at: "x", env: { IMAGE_WANT_BURNERS: "on", EXHAUSTED_WEAK_ACCURATE: "on" } }), flat: JSON.stringify({ AIX_X: "on", lower: "no" }), bad: "{" };
const rd = (f: string) => { if (!(f in files)) throw new Error("no"); return files[f]; };

ok("ファイルの env を読む", JSON.stringify(underlayOf({ EXAM_UNDERLAY_FILE: "a" }, rd)) === JSON.stringify({ IMAGE_WANT_BURNERS: "on", EXHAUSTED_WEAK_ACCURATE: "on" }));
ok("平らな形も読む・小文字の名前は外す", JSON.stringify(underlayOf({ EXAM_UNDERLAY_FILE: "flat" }, rd)) === JSON.stringify({ AIX_X: "on" }));
ok("無い・壊れた・off は {}", Object.keys(underlayOf({}, rd)).length === 0 && Object.keys(underlayOf({ EXAM_UNDERLAY_FILE: "bad" }, rd)).length === 0 && Object.keys(underlayOf({ EXAM_UNDERLAY_FILE: "a", EXAM_UNDERLAY_BASE: "off" }, rd)).length === 0);

// 今＝下敷き（IMAGE_WANT_BURNERS=on）＋依頼（INFO_FILL_MAP=on）。前の既定に下敷きを入れると、指紋は依頼の分だけ
const readers = new Map<string, EnvReader>([["IMAGE_WANT_BURNERS", { kind: "bool", lit: "on", dflt: "", lower: true }], ["INFO_FILL_MAP", { kind: "bool", lit: "on", dflt: "", lower: true }]]);
const now = { IMAGE_WANT_BURNERS: "on", INFO_FILL_MAP: "on" };
const dot = { IMAGE_WANT_BURNERS: "off" };
const old = envFingerprintOf(now, dot, readers);
const base = { ...dot, IMAGE_WANT_BURNERS: "on" };
const fp = envFingerprintOf(now, base, readers);
ok("前の既定が .env.local だけだと下敷きの名前まで指紋に入る（今までの穴）", old.pairs.length === 2, old);
ok("下敷きを入れると指紋は依頼の env だけ", fp.pairs.length === 1 && fp.pairs[0][0] === "INFO_FILL_MAP", fp);
const main = defaultEnvOf(now, fp, base);
ok("前は下敷きのまま・依頼の分だけ既定に戻す", main.IMAGE_WANT_BURNERS === "on" && main.INFO_FILL_MAP === undefined, main);
console.log(`exam-underlay-base: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
