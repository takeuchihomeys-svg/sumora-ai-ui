// 2026-10-08 竹内「ブレインのところ更にキャッシュ効けるところはみつかっていないのかな？質重視で」
//   AIX の文作り（aix_template）の第2システムブロックは、送る中身を1つも変えず「並びの固定」と「寿命 1h」だけを変える。
//   ここでは ①文面が旧の組み立て（route.ts の 10/08 以前のコードをそのまま写した oldBlock）と1文字も同じ
//   ②DB がどの並びで返しても同じ文字列（＝鍵が割れない）③入る原則の集まりは同じ（足さない・抜かない）④戻すスイッチ、を固定する。
// 実行: npx tsx app/lib/__tests__/aix-template-cache.test.ts（自己完結・env 不要。全 OK で exit 0）
import { buildAixTemplateDbKnowledgeBlock, stableKnowledgeOrder, aixTemplateCacheTtl, type AixKnowledgeItem } from "../aix-template-cache";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

// route.ts（2026-10-08 以前）の組み立てを一字一句そのまま写した物（比べる基準）
function oldBlock(topPrinciples: AixKnowledgeItem[], lossPatterns: AixKnowledgeItem[], dbRules: string): string {
  return [
    topPrinciples.length > 0
      ? "【📌 絶対原則（DB学習・全顧客共通・常時遵守）】\n" +
        topPrinciples.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
      : "",
    lossPatterns.length > 0
      ? "【🚫 避けるべき対応（失注実例より）】\n" +
        lossPatterns.map((p, i) => `${i + 1}. ${p.content}`).join("\n")
      : "",
    dbRules ? dbRules.trim() : "",
  ].filter(Boolean).join("\n\n");
}

// 本番の今の形: importance 10 がちょうど12件（全部同点）。題は実物（ai_reply_knowledge principle・10/08）
const TITLES = [
  "仲介手数料と初期費用割引の違い（必須知識）", "審査落ち・物件なし等のネガティブ状況でも謝罪禁止", "日割家賃の正しい計算方法（入居日が早いほど高い）",
  "[盲点回答] AIがおすすめ物件文を作成する際、間取りの帖数", "AIX専用フロー（絶対厳守）", "初回挨拶：ピックアップ姿勢・エリアワード復唱・全力サポート",
  "【NG】感謝返しに「進捗テンプレ」を返すと催促ループになる", "【NG】断り・落胆・キャンセル直後の感謝には営業を一切乗せない",
  "感謝返しに営業を乗せてよい", "感謝返しの実文言分布", "希少性煽りは成約に寄与しない", "【最重要】申込直前シグナル辞書",
];
const IDS = ["69473eb0", "3b1ee734", "760515b9", "4db514d5", "e3e50887", "a358516a", "6b5127af", "c17aadca", "9cb7bfe4", "f3354147", "c9754ef1", "68212af7"];
const principles: AixKnowledgeItem[] = TITLES.map((title, i) => ({ id: IDS[i], title, content: `本文${i}`, importance: 10 }));
const RULES = "  【永久ルール】\n・A\n・B\n";

function shuffle<T>(a: T[], seed: number): T[] {
  const r = [...a]; let s = seed;
  for (let i = r.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

console.log("① 文面は旧の組み立てと同じ（並びだけ固定）");
{
  const sorted = [...principles].sort((a, b) => (a.id < b.id ? -1 : 1));
  t("固定した並びで渡せば旧と1文字も同じ", buildAixTemplateDbKnowledgeBlock(shuffle(principles, 7), [], RULES) === oldBlock(sorted, [], RULES));
  t("原則なし・失注なし・ルールだけでも旧と同じ", buildAixTemplateDbKnowledgeBlock([], [], RULES) === oldBlock([], [], RULES));
  t("全部空なら空文字（旧と同じ＝第2ブロックを付けない）", buildAixTemplateDbKnowledgeBlock([], [], "") === "" && oldBlock([], [], "") === "");
  const loss: AixKnowledgeItem[] = [{ id: "b", content: "失注B", importance: 5 }, { id: "a", content: "失注A", importance: 5 }];
  t("失注パターンも同じ規則（同点は id 順）", buildAixTemplateDbKnowledgeBlock([], loss, "") === oldBlock([], [loss[1], loss[0]], ""));
  const mixed: AixKnowledgeItem[] = [{ id: "z", content: "x", importance: 8 }, { id: "a", content: "y", importance: 9 }, { id: "m", title: "", content: "w", importance: 10 }];
  t("importance の降順は DB と同じ（主の並びは変えない）", stableKnowledgeOrder(mixed).map((p) => p.id).join() === "m,a,z");
  t("題が空なら [] を付けない（旧と同じ）", buildAixTemplateDbKnowledgeBlock(mixed, [], "") === oldBlock([mixed[2], mixed[1], mixed[0]], [], ""));
}

console.log("② DB がどの並びで返しても同じ文字列（鍵が割れない）");
{
  const outs = new Set<string>();
  for (let seed = 1; seed <= 50; seed++) outs.add(buildAixTemplateDbKnowledgeBlock(shuffle(principles, seed), [], RULES));
  t("50通りの並びで出力は1種類", outs.size === 1, outs.size);
  const olds = new Set<string>();
  for (let seed = 1; seed <= 50; seed++) olds.add(oldBlock(shuffle(principles, seed), [], RULES));
  t("（比べ）旧は並びの数だけ別の文字列になっていた", olds.size > 1, olds.size);
}

console.log("③ 入る物は同じ（足さない・抜かない・文を変えない）");
{
  const input = shuffle(principles, 3);
  const out = stableKnowledgeOrder(input);
  t("件数が同じ", out.length === input.length);
  t("同じ集まり", [...out].map((p) => p.id).sort().join() === [...input].map((p) => p.id).sort().join());
  t("各行の中身は同じ物（参照も同じ）", out.every((p) => input.includes(p)));
  t("元の配列は変えない", input.map((p) => p.id).join() === shuffle(principles, 3).map((p) => p.id).join());
  const nl = (s: string) => s.split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, "")).sort().join("\n");
  t("番号を除いた行の集まりは旧と同じ", nl(buildAixTemplateDbKnowledgeBlock(input, [], RULES)) === nl(oldBlock(input, [], RULES)));
}

console.log("④ 戻すスイッチ");
{
  const input = shuffle(principles, 11);
  t("AIX_TEMPLATE_PRINCIPLE_ORDER=db は DB の並びのまま＝旧と同じ", buildAixTemplateDbKnowledgeBlock(input, [], RULES, { AIX_TEMPLATE_PRINCIPLE_ORDER: "db" }) === oldBlock(input, [], RULES));
  t("寿命の既定は 1h", aixTemplateCacheTtl({}) === "1h");
  t("AIX_TEMPLATE_CACHE_TTL=5m で旧", aixTemplateCacheTtl({ AIX_TEMPLATE_CACHE_TTL: "5m" }) === "5m");
  t("知らない値は 1h", aixTemplateCacheTtl({ AIX_TEMPLATE_CACHE_TTL: "10m" }) === "1h");
}

console.log(`\n${passed} OK / ${failed} NG`);
if (failed > 0) process.exit(1);
