// 2026-09-24 竹内「画像で分析が推奨される条件のお客さん（WIC 等）は画像読み取りを推奨なので、画像読み取りボタンをだすかたちとする」
// 実行: npx tsx app/lib/__tests__/image-wants-need.test.ts
// 希望の文は実物の形（条件欄・会話・訴求点）。お客様の情報は無い
import { extractImageWants, dedupeWantsByTopic, imageAnalysisNeed, scoreChecks, wantFeatures, type ImageWant } from "../image-wants";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const need = (preferences: string, ng?: string) => imageAnalysisNeed(dedupeWantsByTopic(extractImageWants({ conditions: { preferences, ng_points: ng ?? null } })));
const REAL_PET = {
  conditions: { preferences: "ペット可の物件があれば、オートロック、ネット無料" },
  customerMessages: [{ text: "もしあればペット可の物件がいいです", created_at: "2026-09-20T00:00:00Z" }],
  sellingPoints: ["ペット可"],
};

// ── 同じ話題の重複をまとめる（実例: ペットが3重） ──
{
  const wants = extractImageWants(REAL_PET);
  t("前提: まとめる前はペットが3つ", wants.filter((w) => w.topics.includes("pet")).length === 3, wants);
  const d = dedupeWantsByTopic(wants);
  const pets = d.filter((w) => w.topics.includes("pet"));
  t("★ ペットの希望は1つにまとまる（代表は条件欄）", pets.length === 1 && pets[0].source === "条件", d);
  t("★ 番号は W1… に振り直す", d.map((w) => w.id).join(",") === d.map((_, i) => `W${i + 1}`).join(","), d.map((w) => w.id));
  t("★ オートロック・ネット無料は残る", d.some((w) => /オートロック/.test(w.text)) && d.some((w) => /ネット無料/.test(w.text)), d);
  // ペット相談のアイコン1つ＋他は分からない → 1項目分の ok（3重に数えない）
  const checks = d.map((w) => ({ id: w.id, result: (w.topics.includes("pet") ? "ok" : "unknown") as "ok" | "unknown", why: "" }));
  t("★ ペットの ok は1項目分だけ数える", scoreChecks(d, checks) === 100 && checks.filter((c) => c.result === "ok").length === 1);
}
{
  const w: ImageWant[] = [
    { id: "W1", source: "条件", text: "バストイレ別", topics: ["water"], ng: false, must: false },
    { id: "W2", source: "条件", text: "独立洗面台", topics: ["water"], ng: false, must: false },
    { id: "W3", source: "会話", text: "お風呂とトイレは絶対別で", topics: ["water"], ng: false, must: true },
  ];
  const d = dedupeWantsByTopic(w);
  t("★ 同じ水回りでもバストイレ別と独立洗面は別の希望のまま", d.length === 2, d);
  t("★ まとめた時の必須は引き継ぐ（条件の文が代表・must=true）", d[0].text === "バストイレ別" && d[0].must === true, d[0]);
}
{
  const w: ImageWant[] = [
    { id: "W1", source: "条件", text: "ペット可", topics: ["pet"], ng: false, must: false },
    { id: "W2", source: "条件", text: "ペット可NG", topics: ["pet"], ng: true, must: false },
  ];
  t("★ 向き（NG か）が違えばまとめない", dedupeWantsByTopic(w).length === 2);
}
{
  const w: ImageWant[] = [
    { id: "W1", source: "会話", text: "リビングと寝室の生活空間を分けたい", topics: ["layout"], ng: false, must: false },
    { id: "W2", source: "会話", text: "洋室が小さそう", topics: ["layout", "size"], ng: true, must: false },
  ];
  t("★ 細かい設備に当たらない希望はまとめない（誤って消さない）", dedupeWantsByTopic(w).length === 2);
}

// ── 画像で分析を勧めるか ──
{
  const n = need("WIC希望、バストイレ別");
  t("★ WIC・バストイレ別 → recommended（labels に WIC とバストイレ別）", n.level === "recommended" && n.labels.includes("WIC") && n.labels.includes("バストイレ別"), n);
}
t("★ 対面キッチンがいい → recommended", need("対面キッチンがいい").level === "recommended");
t("★ 独立洗面台 → recommended", need("独立洗面台").labels.includes("独立洗面"));
{
  const n = imageAnalysisNeed(dedupeWantsByTopic(extractImageWants(REAL_PET)));
  t("★ 実例型（ペット×3＋オートロック＋ネット無料）→ optional", n.level === "optional" && n.labels.length === 0, n);
}
t("★ 希望なし → none", need("").level === "none");
t("★ 「シューズWIC」だけ → recommended にしない", need("シューズWIC").level === "optional", need("シューズWIC"));
t("★ 「シューズWIC、WIC」→ WIC で recommended", need("シューズWIC、WIC").labels.includes("WIC"));
t("★ ウォークインクローゼット → 表示は WIC だけ（収納と二重にしない）", JSON.stringify(need("ウォークインクローゼット").labels) === JSON.stringify(["WIC"]), need("ウォークインクローゼット"));
{
  const n = imageAnalysisNeed([{ id: "W1", source: "会話", text: "リビングと寝室兼書斎の生活空間を分けたい", topics: ["layout"], ng: false, must: false }]);
  t("★ 部屋の配置（リビングと寝室を分けたい）→ recommended・短い言葉", n.level === "recommended" && n.labels[0].length <= 14, n);
}
t("★ 設備の読み: SIC は shoes_ic・BASIC は当たらない", wantFeatures("SIC").includes("shoes_ic") && !wantFeatures("BASIC").includes("shoes_ic"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
