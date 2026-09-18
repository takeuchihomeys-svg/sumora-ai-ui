// app/lib/__tests__/send-pairing.test.ts
// Chrome 拡張の「PDF と説明文の組」の作り方（chrome-extension/send-pairing.js）。
// 2026-09-18 竹内「SATOKOさんのURL開いたらMATSUOさんの物件が出てきた」の回帰テスト。
// 実行: npx tsx app/lib/__tests__/send-pairing.test.ts
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

type Item = { url?: string | null; pdf?: string | null; name?: string; rank?: number };
type Target = { cb: { checked: boolean }; btn: { href: string | null }; name?: string };

const P = require_("../../../chrome-extension/send-pairing.js") as {
  isHttpUrl(u: unknown): boolean;
  isSendableTarget(t: unknown): boolean;
  selectSendableTargets(tracked: Target[]): Target[];
  hasPayload(item: unknown): boolean;
  prepareItems(raw: Item[]): { items: Item[]; dropped: number };
  splitBatches<T>(items: T[], size: number): T[][];
  pluck(items: Item[], field: string): unknown[];
};

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

const target = (checked: boolean, href: string | null, name: string): Target =>
  ({ cb: { checked }, btn: { href }, name });

console.log("── 送れる行の判定は1か所（リアプロの穴）");
{
  // 旧: getSelectedUrls() は「checked かつ http(s) の href」、説明文は「checked」だけ
  //     → href の無い行があると、その行以降の PDF と説明文が全部1つズレていた
  const tracked = [
    target(true, "https://x/1.pdf", "A"),
    target(true, "https://x/2.pdf", "B"),
    target(true, null, "C"),              // ← 印刷用PDFのリンクが無い行
    target(true, "https://x/4.pdf", "D"),
    target(false, "https://x/5.pdf", "E"), // ← チェックなし
  ];
  const sendable = P.selectSendableTargets(tracked);
  t("href の無い行とチェックなしの行は落ちる",
    sendable.length === 3 && sendable.map((s) => s.name).join(",") === "A,B,D",
    JSON.stringify(sendable.map((s) => s.name)));
  t("javascript: の href は送れない", !P.isSendableTarget(target(true, "javascript:void(0)", "X")));
  t("同じ判定を両方が使えば件数が必ず一致する",
    P.selectSendableTargets(tracked).length === P.selectSendableTargets(tracked).map((s) => s.btn.href).length);
}

console.log("── 組にしてから分ける（ズレようがない形）");
{
  const raw: Item[] = [
    { url: "https://x/1.pdf", name: "A" },
    { url: "https://x/2.pdf", name: "B" },
    { url: "https://x/3.pdf", name: "C" },
  ];
  const { items } = P.prepareItems(raw);
  const batches = P.splitBatches(items, 2);
  t("2件ずつに分かれる", batches.length === 2 && batches[0].length === 2 && batches[1].length === 1);
  t("同じ chunk から URL と名前を作れば必ず対応する",
    P.pluck(batches[0], "url").join(",") === "https://x/1.pdf,https://x/2.pdf" &&
    P.pluck(batches[0], "name").join(",") === "A,B");
  t("size 未指定でも落ちない", P.splitBatches(items, 0 as number).length === 1);
  t("空でも落ちない", P.splitBatches([], 10).length === 0 && P.prepareItems([]).items.length === 0);
}

console.log("── 【itandi の穴】PDF 取得に失敗した1件で以降が全部ズレない");
{
  // 旧: 失敗した行は pdfBase64List に push されないのに、説明文は propertyInfos[j] で引いていた
  //     → 3件目が失敗すると 4件目の PDF に 3件目の名前が付く
  const raw: Item[] = [
    { pdf: "PDF-A", name: "A" },
    { pdf: "PDF-B", name: "B" },
    { pdf: null,    name: "C" },   // ← 取得失敗
    { pdf: "PDF-D", name: "D" },
  ];
  const { items, dropped } = P.prepareItems(raw);
  t("失敗した組は落ちる", items.length === 3 && dropped === 1);
  t("残った組は PDF と名前が必ず一致する",
    items.every((it) => it.pdf === "PDF-" + it.name),
    JSON.stringify(items));
  t("番号は 1 から詰め直される（欠番を作らない）",
    items.map((it) => it.rank).join(",") === "1,2,3");
}

console.log("── 【レインズの穴】説明文が全件・PDF が成功分だけ、で件数が食い違わない");
{
  const raw: Item[] = [
    { pdf: "図面1", name: "あ" },
    { pdf: "",      name: "い" },  // ← 空文字も未取得として扱う
    { pdf: "図面3", name: "う" },
  ];
  const { items } = P.prepareItems(raw);
  t("空文字の PDF は送らない", items.length === 2 && P.pluck(items, "name").join(",") === "あ,う");
  t("PDF の件数と説明文の件数が必ず一致する",
    P.pluck(items, "pdf").length === P.pluck(items, "name").length);
}

console.log("── 欠けの判定");
{
  t("http(s) の url は送れる", P.hasPayload({ url: "https://x/a.pdf" }));
  t("相対 url は送れない", !P.hasPayload({ url: "/a.pdf" }));
  t("url も pdf も無ければ送れない", !P.hasPayload({ name: "A" }) && !P.hasPayload(null));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
