// app/lib/quoted-conditions.ts
// 下書きで条件を「」で囲んだ形（「大国町駅周辺・1K/1LDK・築20年以内・ペット猫可・初期費用30〜35万円」の条件で…）の「」を外す出口（純関数）。
//
// 2026-10-02 ⑫の再生（DeepSeek）で見つけた下書き。スタッフは条件を「」で囲まずに宣言に織り込む
//   （「大国町・難波周辺全域から管理費込み7万以内・1Kでオススメできるお部屋ピックアップしてお送りさせて頂きます！！」）。
// 線（365日の本番のスタッフの送信 13,260通）: 「」の中が条件の並び（・／区切り＋駅・万・間取り等）なのは2通（どちらも5月の AI 由来の文）・
//   AI の下書き 3,178通で 0通（DeepSeek の新しい形）。外すのは「」の後ろが「の条件／で／から／にて／に合」の時だけ・中に「、」がある例文（「独立洗面台は必須だが、…」）は触らない。

export type QuotedCondFix = { text: string; removed: string[] };

const COND_RE = /万|駅|[0-9０-９]\s*(?:S?LDK|DK|K|R)(?![A-Za-z])|ワンルーム|築|徒歩|ペット|オートロック|バストイレ|区|エリア|周辺/;
const QUOTE_RE = /「([^」「\n]{3,80})」(?=\s*(?:の(?:ご)?(?:希望)?(?:ご)?条件|で|から|にて|に合))/g;

export function unquoteConditions(text: string | null | undefined): QuotedCondFix {
  const s = String(text ?? "");
  const removed: string[] = [];
  const out = s.replace(QUOTE_RE, (m, inner: string) => {
    if (!COND_RE.test(inner) || !/[・／/]/.test(inner) || /[、。！？!?]/.test(inner)) return m;
    removed.push(m);
    return inner;
  });
  return removed.length ? { text: out, removed } : { text: s, removed };
}
