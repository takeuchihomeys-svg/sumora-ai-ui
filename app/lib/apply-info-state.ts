// app/lib/apply-info-state.ts
// 申込の意思の番で「お客様の申込の情報（記入済みのフォーマット・本人確認書類）がもう届いているか」を会話から読む（純関数・DB を持たない）。
//
// 2026-11-11 作業員3（弱い所 280・386・452・473・統括役の A2）:
//   竹内さん本人の 200日の申込の意思の番（書類の手前で切って数えた）の分かれ目は「入居希望日」でなく「申込の情報が届いているか」だった。
//     ・情報がまだ（フォーマットも未送付）の番 12: 同じ番に AIX【申込】のフォーマット 10（「かしこまりました！！お申込させて頂きます！！」の返信が先 7・フォーマットが先 3）／
//       返信だけ 2（夜の部屋止め 1・初期費用の問いに見積書 1）
//     ・情報が届いた後（審査落ちの切り替え・2部屋目・並行・こちらがもう申込を出した）の番 5: 返信だけ 5/5（全スタッフ 27番中 25・AIX は新しい記入が要った 2）
//     （11/11 w3-afs-on: 「1番手で抑えれているか確認」＝もう申込を出した、を届いた後に数え直した＝q302）
//     ・フォーマットは送ったが記入はまだ 2: 返信 1・送り直し 1
//   数え直し: scripts/audit-apply-info-state.ts（読むだけ・--writer=takeuchi|all --list）
//   週の振り返りの 25%（W45）の外れ 9 のうち 8 は届いた後の番（84b560f4・969f0162・b50fd451）＝ブレインが AIX【申込】・スタッフは返信。
//   → 判断はブレイン（P0 9eb6aa9c）。ここは事実（届いているか）だけを決め、材料の1行にする。
//
// 戻す: APPLY_INTENT_FORM_STATE=off（11/11 既定 on・竹内さんの決定 KB 2385202c）

export type ApplyInfoState = "none" | "form_sent" | "received";
export type ApplyInfoMsg = { sender: string; text: string | null; created_at: string; image_type?: string | null };
export type ApplyInfoReading = { state: ApplyInfoState; at: string | null; via: string | null };

/** DB で該当の通だけ引く絞り（PostgREST の or）。読み方は readApplyInfoState が決める */
export const APPLY_INFO_OR_FILTER = "text.ilike.%記入欄】%,text.ilike.%完了%,text.ilike.%否決%,text.ilike.%審査継続%,text.ilike.%審査通過%,text.ilike.%審査承認%,text.ilike.%情報で%,text.ilike.%以前いただきました%,text.ilike.%以前頂きました%,text.ilike.%番手で%,image_type.eq.id_document,image_type.eq.income_document";

/** 申込フォーマットの見出し（こちらが送る・お客様が記入して返す） */
const FORM_RE = /記入欄】/;
/** お客様が送ってきた書類の画像の見出し（読み取りの後の「[画像] 本人確認書類」） */
const CUSTOMER_DOC_RE = /^\[画像\]\s*(?:本人確認書類|収入証明書)/;
/**
 * こちらの文で「この方の申込（審査）がもう動いた」と分かる形。お客様の情報が届いていないと書けない。
 *   ・申込の完了の報告（「無事一番手にてお申込み完了しております」「お部屋のお申し込み完了しております」）
 *   ・審査の結果・継続（「審査が否決となり」「審査継続」「審査通過」）
 *   ・前の情報を使う（「以前いただきましたご情報でお申し込み可能」）
 * 他の方の申込（「1番手のお申込が入っております」）・まだの報告（「お申込が完了していない状況」）は数えない。
 */
const STAFF_DONE_RE = new RegExp([
  String.raw`お?申し?込み?(?:が|は)?(?:無事)?(?:[1-3一二三]番手(?:にて|で)?)?(?:お?申し?込み?)?(?:手続き)?完了(?!して(?:い)?な|では|でき|出来|次第|しましたら|しているか|か)`,
  // 説明の文（「審査通過しますと」「審査通過次第ご入居可能」「1番手の方が否決・キャンセルの場合」）は数えない＝結果の報告の形だけ
  String.raw`審査(?:が|は)?(?:通過|承認)(?:致し|いたし|し)(?:ました|ております)`,
  String.raw`審査(?:が|は)?否決`,
  String.raw`審査継続`,
  String.raw`否決(?:と|に)なり(?:まし|、|。|！|!)`,
  String.raw`以前(?:いただ|頂)きました(?:ご)?情報`,
  String.raw`(?:いただ|頂)きました(?:ご)?情報で(?:お?申し?込|審査)`,
  // こちらがもう申込を出した（「無事1番手でお部屋抑えれているか明日管理会社確認」「1番手で無事お申込完了しているか確認」）＝情報は手元にある（電話で聞いた時も）
  String.raw`[1一]番手で(?:無事)?(?:お部屋)?(?:抑え|押さえ)(?:れて|られて)いるか`,
  String.raw`[1一]番手で(?:無事)?お?申し?込み?(?:が)?完了しているか`,
].join("|"));

/** 会話（古→新でも新→古でもよい）から申込の情報の状態を読む */
export function readApplyInfoState(msgs: ReadonlyArray<ApplyInfoMsg>): ApplyInfoReading {
  const sorted = [...msgs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let received: { at: string; via: string } | null = null;
  let formSent: { at: string } | null = null;
  for (const m of sorted) {
    const t = String(m.text ?? "").normalize("NFKC");
    if (m.sender === "customer") {
      if (FORM_RE.test(t)) received = { at: m.created_at, via: "customer_form" };
      else if (m.image_type === "id_document" || m.image_type === "income_document" || CUSTOMER_DOC_RE.test(t)) received = { at: m.created_at, via: "customer_docs" };
    } else {
      if (FORM_RE.test(t)) formSent = { at: m.created_at };
      if (STAFF_DONE_RE.test(t)) received = { at: m.created_at, via: "staff_done" };
    }
  }
  if (received) return { state: "received", at: received.at, via: received.via };
  if (formSent) return { state: "form_sent", at: formSent.at, via: "staff_form" };
  return { state: "none", at: null, via: null };
}

/** お客様の今の連投が申込の意思（申込したい・押さえたい・審査を通して）か */
export function isApplyIntentTurn(customerText: string | null | undefined): boolean {
  const raw = String(customerText ?? "");
  const t = raw.normalize("NFKC");
  if (!t.trim()) return false;
  if (/(?:費用|家賃|賃料|料金|コスト|金額|予算)[^。]{0,20}抑え/.test(t)) return false;
  // 条件のフォーム（①入居時期…「予算を抑えたい」）・条件付き（「初期費用確認次第申し込み」「大丈夫なら明日申し込み」）は申込を決めた番ではない
  if (/[①②③]|ご希望のお部屋探し|【ご入居の時期】/.test(raw)) return false;
  //   「可能であれば明日抑えて欲しい」「よろしければ」は丁寧な頼み＝残す
  if (/(?:次第|なら|ならば|たら|(?<!可能であ|よろし|出来|でき)れば)[、,\s]*(?:すぐ|明日|一応)?[^。\n]{0,8}(?:申し?込|審査|押さえ|抑え)/.test(t)) return false;
  // 申込の可否・流れの質問（「申し込みできますか？」「今申し込みすると最短でいつから」）は外す。丁寧な頼み（「審査通して頂いてもよろしいでしょうか」）は残す
  if (/(?:申し?込|申込|審査)[^。\n]{0,14}(?:[？?]|ですか|でしょうか|できますか|出来ますか|可能)/.test(t)
    && !/(?:お願い(?:します|致します|いたします|したい)|したいです|させて(?:頂|いただ)きたい|(?:頂|いただ)いても(?:よろしい|いい|大丈夫)|(?:頂|いただ)けますか|(?:もらえ|貰え)ますか)/.test(t)) return false;
  return /(?:申し?込み?|申込)(?:を|は)?(?:ぜひ|是非|一旦|一度)?(?:お願い|したい|します|させて(?:頂|いただ)き(?:たい|ます)|たい|進め)|申し?込みます|審査(?:を)?(?:一旦|一度|まず)?(?:通して|進めて|お願い|かけて)|(?:押さえ|抑え)(?:たい|て(?:ほしい|欲しい|もらえ|頂|いただ|下さ|くだ))|(?:お?部屋|ここ|こちら)(?:を)?(?:押さえ|抑え)|契約(?:させて(?:頂|いただ)き(?:たい|ます)|したい|します|をお願い)/.test(t);
}

export function applyIntentFormStateOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.APPLY_INTENT_FORM_STATE ?? "").trim().toLowerCase() !== "off"; // 11/11 既定 on（w3-afs-on・on2 確かな悪化0・道/本質の悪化0・竹内さんの決定 2385202c）
}

/** ブレインに渡す1行（事実だけ・中身の個人の値は書かない）。申込の意思の番でなければ空 */
export function applyInfoBrainLine(reading: ApplyInfoReading, customerText: string | null | undefined): string {
  if (!isApplyIntentTurn(customerText)) return "";
  const day = reading.at ? reading.at.slice(0, 10) : null;
  const head = "【申込の情報（この方の申込に要る記入・本人確認書類が届いているか・会話から決まった事実）】";
  if (reading.state === "received") {
    return `\n\n${head}\n届いている（${day ?? "日付不明"}・${reading.via === "staff_done" ? "こちらが申込完了／審査の結果を伝えた" : "お客様が記入・書類を送った"}）。前の情報でお申込みできる＝フォーマットは送り直さない。竹内さんはこの状態の申込の意思の番で返信で受けた（5番中 5・全スタッフ 27番中 25）＝AIX【申込】は選ばず aix は空・route=\"reply\"（「かしこまりました！！〇〇号室お申込みさせていただきます！！」＋要る時だけ入居希望日の確認／明日管理会社に確認の約束）。代理契約の親など新しい記入が要る時だけ AIX【申込】。`;
  }
  if (reading.state === "form_sent") {
    return `\n\n${head}\nフォーマットは送った（${day ?? "日付不明"}）が、記入・本人確認書類はまだ届いていない。竹内さんは返信でご入力と本人確認書類をお願いした（フォーマットは送り直さない）。`;
  }
  return `\n\n${head}\nまだ（フォーマットも送っていない）。竹内さんはこの状態で 12番中 10 が返信の受け（「かしこまりました！！〇〇号室お申込みさせていただきます！！」）→同じ番に AIX【申込】のフォーマット＝aix=\"application_push\"。`;
}
