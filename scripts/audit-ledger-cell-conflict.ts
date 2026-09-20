// 行動台帳の「書くな」と 往復文脈セルの「書け」の正面衝突を全部洗う（読み取りのみ・DB 不要）
//
// 2026-09-20 竹内（まりあさん事例）「他にもこのようなミスが起きる可能性あるからそこの原因ちゃんと把握する」
//
// まりあさんの「お申込み情報受け取りました」の根本原因は、同じ生成に
//   行動台帳 : 「この内覧は決まっている。…「ご案内させて頂きます」は書かない」
//   ES_POSITIVE: 「『ご都合よろしいお日にちにご案内させて頂きます😊！！』を1文入れる」（必須）
// という**正面から矛盾する2つの必須**が渡っていたこと。LLM はどちらも避けた第三の文を作る。
//
// 台帳（buildActionLedgerNote）が出す禁止は4種類。どれもセルの必須要素と衝突しうるので、
// 「その禁止が出ている状態で、その語を必須にするセル」を静的に列挙する。
// ここに出た組み合わせは、実際にその状態でそのセルが選ばれた瞬間に必ず壊れる。
import { PAIR_MATRIX, type PairRule } from "../app/lib/reply-context";

/** 台帳が出す禁止（buildActionLedgerNote の各行）と、その禁止が有効になる条件 */
const LEDGER_BANS: Array<{ id: string; when: string; re: RegExp; note: string }> = [
  { id: "redo", when: "物件を1件も送っていない（redoAllowed=false）",
    re: /再度|改めて|もう一度|追加で|別の物件|先ほどお送りした|ご査収/,
    note: "「再度」「改めて」「先ほどお送りした」等は二度目が存在しないので使えない" },
  { id: "estimate", when: "御見積書を送付済み（estimateSent=true）",
    re: /(?:御|お)?見積(?:書|り|もり)?[^\n。！!]{0,14}(?:作成|お送り|ご用意)/,
    note: "「御見積書を作成しお送りします」の再宣言は禁止" },
  { id: "vacancy", when: "募集状況の確認を実行・報告済み",
    re: /(?:募集状況|空室状況|空き状況)[^\n。！!]{0,10}(?:確認|お調べ)/,
    note: "「確認します」の再宣言は禁止" },
  { id: "viewing", when: "内覧の待ち合わせが決まっている（viewingAppointment あり）",
    re: /ご都合(?:の)?よろしい(?:お日にち|日)/,
    note: "新しい日程の打診は書かない（決まっている日時をそのまま言う）" },
];

/** セルが LLM に「書け」と渡す文字列（direction・必須要素の label と fix・例文） */
function writeSides(r: PairRule): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [{ where: "direction", text: r.direction }];
  r.mustInclude.forEach((m, i) => {
    out.push({ where: `mustInclude[${i}].label`, text: m.label });
    out.push({ where: `mustInclude[${i}].fix`, text: m.fix });
    (m.preferWhenAvoid ?? []).forEach((p, j) => out.push({ where: `mustInclude[${i}].preferWhenAvoid[${j}].use`, text: p.use }));
  });
  out.push({ where: "example", text: r.example });
  if (r.exampleFallback) out.push({ where: "exampleFallback", text: r.exampleFallback });
  if (r.exampleBySent) {
    out.push({ where: "exampleBySent.none", text: r.exampleBySent.none });
    out.push({ where: "exampleBySent.sent", text: r.exampleBySent.sent });
  }
  return out;
}

/** その禁止を、セル自身が mustNot で既に除外しているか（＝設計者が気づいて潰してある） */
function guarded(r: PairRule, banId: string): boolean {
  const mn = r.mustNot.join("／");
  if (banId === "estimate") return /見積/.test(mn);
  if (banId === "vacancy") return /募集状況|再確認/.test(mn);
  if (banId === "viewing") return /ご都合|お日にち|日程/.test(mn);
  if (banId === "redo") return /再度|改めて|実行済み/.test(mn);
  return false;
}

function main() {
  console.log(`=== 往復文脈セル ${PAIR_MATRIX.length}件 × 台帳の禁止 ${LEDGER_BANS.length}種類 ===\n`);
  let hard = 0, soft = 0;
  for (const ban of LEDGER_BANS) {
    const hits: Array<{ rule: PairRule; where: string; text: string }> = [];
    for (const r of PAIR_MATRIX) {
      for (const w of writeSides(r)) {
        if (ban.re.test(w.text)) { hits.push({ rule: r, where: w.where, text: w.text }); break; }
      }
    }
    console.log(`── 【${ban.id}】${ban.when}`);
    console.log(`   台帳: ${ban.note}`);
    if (hits.length === 0) { console.log(`   ✅ 衝突なし\n`); continue; }
    for (const h of hits) {
      const g = guarded(h.rule, ban.id);
      if (g) soft++; else hard++;
      const mark = g ? "🟡 mustNot で除外済み" : "🔴 **衝突**";
      console.log(`   ${mark} ${h.rule.id} (${h.where})`);
      console.log(`      「${h.text.replace(/\n/g, " ").slice(0, 110)}」`);
      if (!g) console.log(`      → この状態でこのセルが選ばれると「書くな」と「書け」が同時に渡る`);
    }
    console.log("");
  }
  console.log(`=== 🔴 未対処の衝突 ${hard}件 ／ 🟡 mustNot で除外済み ${soft}件 ===`);
  // ── 2026-09-20 目で読んだ結果（件数だけ見ない・止めた判断もここに残す）──────────────
  //  【viewing】… 実害あり。**直した**。例文4件（PS/CR_POSITIVE・CR_ANY・ANY_POSITIVE）を {viewingOffer} に寄せ、
  //     VI_POSITIVE の direction / fix に台帳分岐を入れた。残るのは台帳を見て言い回しが切り替わる形だけ。
  //  【estimate】【vacancy】… **直さない**。ここに出るのは「お客様がこれから送る／新しく送られた物件」の
  //     見積作成・募集状況確認で、台帳が言う「過去に送った物件の見積・確認は済んでいる」とは**対象が違う**。
  //     同じ語でも対象が違うので衝突ではない（PS_WILL_SEND・ES_WILL_SEND・ANY_WILL_SEND・CP_ACK・PD_WILL_SEND）。
  //     PS_POSITIVE / ANY_POSITIVE / QC_ANSWER の direction は「次の一手を1つ選べ」の**選択肢**で、
  //     台帳が1つを塞いでも他を選べる（preferWhenAvoid が選択肢を削る仕組みも既にある）。
  //  【redo】… **直さない**。PS_CONDITION_CHANGE / PS_CONDITION_CHANGE_SEARCHED は「送付済み」が
  //     セルの前提なので redoAllowed=false とは**排他**（同時に起きない）。VI_CONCERN の例文は
  //     exampleRequires でゲートされ、{redo} トークンが台帳を見て語を出し分けている。
  //  → 教訓: 台帳とセルが同じ語を扱う時は、禁止を並べ合うのではなく**トークン1つに寄せて台帳を見させる**
  //     （{redo} と {viewingOffer} がその形）。mustNot は文章の禁止なので必須要素とは打ち消し合えない。
  console.log(`\n※ 静的な組み合わせの列挙。実際に壊れるのは「その台帳の状態で・そのセルが選ばれた」瞬間。`);
  console.log(`  mustNot は LLM への文章の禁止なので、必須要素（mustInclude）と同時に出ると衝突は残る。`);
  console.log(`  本当に安全なのは、まりあさん事例で採った形＝**必須要素の側が台帳を見て言い回しを切り替える**（{viewingOffer}）。`);
}
main();
