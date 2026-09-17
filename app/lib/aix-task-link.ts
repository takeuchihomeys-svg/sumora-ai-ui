// app/lib/aix-task-link.ts
// AIX の送信と「やること（line_tasks）」・物件出しの完了（✅）の対応表（2026-09-12 竹内方針）。
//   「AIX 物件オススメ・物件ピックアップで送ったときに物件出し完了となる。ここちゃんとリンクさせる」
//   旧: AIX を何か1つ送ると、その会話の未完了タスクを種類を問わず全部完了にしていた
//       （名無しの権兵衛さんに「内覧へ！」を送っただけで「✅【物件出し 完了】」が売上番長グループに流れた）。
//   物件出しの完了・一覧の✅・物件出し顧客の送付記録は、すべてこの表だけを見る。依存なし（画面・API どちらからも使える）。

/** 物件を届けた AIX（物件出しの完了になる AIX） */
export const PROPERTY_DELIVERY_AIX: readonly string[] = ["property_send", "property_recommendation"];

export function isPropertyDeliveryAix(aixType: string | null | undefined): boolean {
  return !!aixType && PROPERTY_DELIVERY_AIX.includes(aixType);
}

/**
 * その AIX を送った時に完了にする「やること」の種類。
 *   物件出し（property_send）  ← 物件ピックアップした／物件オススメ
 *   物件確認（property_check） ← 物件確認した（結果の報告。確認します＝管理会社への依頼では完了しない）
 *   見積書対応（estimate_sheet）← 見積書送る
 *   それ以外の AIX（内覧へ！・待ち合わせ・申込へ！ 等）は、どのやることも完了にしない
 */
export function taskTypesCompletedByAix(aixType: string | null | undefined): string[] {
  if (isPropertyDeliveryAix(aixType)) return ["property_send"];
  if (aixType === "property_check_result") return ["property_check"];
  if (aixType === "estimate_sheet") return ["estimate_sheet"];
  return [];
}

/**
 * スタッフの未履行の宣言 → それを履行する AIX（ブレインの AIX 判断基準・2026-09-12 竹内）。
 *   「見積書送る宣言したら AIX 見積書送る をセットする。これも AIX でセットした状態。LINE グループにアナウンスするまでがセット」
 *   会話の最後がスタッフの宣言（まだ履行していない）の時だけ:
 *     見積書の宣言（estimate_declared）            → estimate_sheet（見積書送る）
 *     今ピックアップする宣言（pickup_declared）      → property_send（物件ピックアップした）
 *     募集状況等の確認の宣言（confirmation_promised）→ property_check_result（物件確認した）
 *       ※お客様から物件確認の依頼があった時だけ（opts.customerRequestedCheck。「物件確認したもお客さんから依頼があった場合」）。
 *         2026-09-12 竹内（Sさん事例）: 物件の画像8枚＋「空いているか確認お願いしたいです」→ スタッフ「お送り頂きました物件、募集状況確認させて頂きます😊！！
 *         確認出来次第ご連絡させて頂きます！！」→ 旧: AIX が何もセットされなかった（約束の種類が見積書・ピックアップだけだった）。
 *         初期費用の割引・交渉の確認は物件確認ではないので対象外
 *   「新着が出次第お送り」のような条件付き（次第）の宣言は、いつ届けるか決まっていないので対象外（毎回の締めに AIX が付くのを防ぐ）。
 *   （確認の「確認出来次第ご連絡」は届ける中身＝確認結果が決まっているので対象）
 *   宣言の判定は action-ledger（classifyStaffTextForLedger・buildActionLedger）と同じ結果を使う。
 */
/** 募集状況（空室）を確認する宣言（未来形）。「確認させて頂きました」「募集ございませんでした」等の報告は含めない */
const VACANCY_CHECK_DECL_RE = /(?:募集状況|空室状況|空き状況|空室|空き)[^\n。！!]{0,20}確認(?:させて(?:頂|いただ)きます|いたします|致します|して(?:参|まい)ります)/;

/**
 * 申込の進捗の確認（番手・お部屋止め・お申込完了・審査の進捗）。AIX【物件確認した（募集状況）】ではない。
 * 2026-09-16 竹内（カイナ事例）「何故か物件確認したが間違ってアナウンスされる」:
 *   AIX【申込確定】の本文「無事一番手でお部屋止め完了確認出来次第ご連絡させて頂きます！！」（12:06）が
 *   confirmation_promised（object=番手）として記録され、12:07 のブレインが decision_source=promise:check で
 *   property_check_result をセット → 売上番長グループに「AIX【物件確認した（募集状況）】」と誤アナウンスされた。
 *   実データ（120日）: この型の13件すべて、その後スタッフが送るのは手打ちの報告
 *   （「無事一番手にてお申込み完了しております！！審査の進捗あり次第ご連絡させていただきます」）で、
 *   AIX【物件確認した】は1件も使われていない。約束としては本物（カレンダーには残す）が、押すべき AIX は無い
 */
const APPLY_PROGRESS_CHECK_RE = /番手|お?部屋止め|お?申込(?:み)?(?:が)?完了|審査[^\n]{0,8}(?:進捗|結果|状況|通過)/;

export function resolveStaffPromiseAix(
  facts: {
    lastStaffEntry: { kind: string; status: string; evidence?: string | null; detail?: { object?: string | null; watch?: boolean } } | null;
    /** 直前スタッフ発言が AIX の時、その本文に書き足した未履行の約束（2026-09-15 ゆうこ事例: 初期費用について＋「ピックアップさせて頂きます」） */
    lastStaffAixTextPromise?: { kind: string; status: string; evidence?: string | null; detail?: { object?: string | null; watch?: boolean } } | null;
    estimatePromisedUnfulfilled: boolean;
    pickupPromisedUnfulfilled: boolean;
    confirmationPromisedUnfulfilled?: boolean;
  },
  messages: ReadonlyArray<{ sender: string; text?: string | null }>,
  opts: {
    customerRequestedCheck?: boolean;
    /** 宣言より前の顧客の連投が「これから自分で物件を送る予告」（CUST_WILL_SEND_SELF_PRED・URL/画像なし）。
     *  2026-09-12 竹内（あや事例）: 物件はまだ届いていないので、見積書・物件確認の宣言があっても AIX はまだ無い（届いてからブレインが判断） */
    customerWillSend?: boolean;
    /** 宣言の後にお客様が了承だけを返した（「お願いします！」「ありがとうございます」）。
     *  2026-09-12 竹内（YUYA 事例）: 確認の宣言 → お客様「お願いします！」→ ブレインが 確認します（acknowledge_check）に戻していた。
     *  実績（150日）: 確認の宣言＋お客様の了承の後に押された AIX 35件中 物件確認した 26件（74%）・確認します 0件 → 宣言の AIX を保つ */
    customerAckAfter?: boolean;
    /** 見積る物件があるか（こちらの送付・お客様の URL/画像/「ここの」/見積の語）。false の時は見積書の宣言でも 見積書送る をセットしない（ゆうこ事例）。未指定は従来どおり */
    propertyInPlay?: boolean;
  } = {},
): { action: "estimate_sheet" | "property_send" | "property_check_result"; kind: "estimate" | "pickup" | "check"; alt?: "property_recommendation" } | null {
  const nonMedia = messages.filter((m) => {
    const t = (m.text ?? "").trim();
    return t && !/^\[(?:画像|動画|スタンプ|ファイル)\]/.test(t);
  });
  const lastAny = nonMedia[nonMedia.length - 1];
  if (!lastAny || (lastAny.sender !== "staff" && !opts.customerAckAfter)) return null;
  const last = [...nonMedia].reverse().find((m) => m.sender === "staff");
  if (!last) return null;
  // 直前が AIX（済み）で、その本文に約束を書き足していれば、その約束を直前の宣言として扱う
  const e = facts.lastStaffEntry?.status === "promised" ? facts.lastStaffEntry : (facts.lastStaffAixTextPromise ?? facts.lastStaffEntry);
  if (!e || e.status !== "promised") return null;
  // 物件が届く前の「お送り頂き次第…御見積書」は、届いてからの約束（見積るものがまだ無い）
  if (opts.customerWillSend && (e.kind === "estimate_declared" || e.kind === "confirmation_promised")) return null;
  // 2026-09-12 竹内（find-brain-gaps G4）: 「お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第、最大限割引させていただいた初期費用の
  //   お見積書お送りさせて頂きます」のような確認＋見積書の宣言は、台帳では見積書の宣言になるが、スタッフが先に押すのは物件確認した
  //   （150日の実績: 最初に押された AIX 48件中 物件確認した 34件（71%）・見積書送る 11件。確認の後に見積書が続いたのは 34件中 11件）。
  //   見積書は確認の結果（空いていたか）とお客様の反応を見てから（固定連鎖にしない）。お客様から物件確認の依頼があった時だけ
  if (e.kind === "estimate_declared" && facts.estimatePromisedUnfulfilled && opts.customerRequestedCheck
    && VACANCY_CHECK_DECL_RE.test(last.text ?? "")) return { action: "property_check_result", kind: "check" };
  // 2026-09-14 竹内（ゆうこ事例）「見積書は物件が送られた時や物件の画像が送られた時等や見積依頼があった時」:
  //   物件が1件も無い時の見積書の約束（物件0件の最初の返信に入った約束）では 見積書送る をセットしない（見積る物件が無い）
  //   物件の有無は呼び出し側（brain-core）が cost-question-scope で判定して渡す（このファイルは画面からも読むので依存を持たない）
  if (e.kind === "estimate_declared" && facts.estimatePromisedUnfulfilled && opts.propertyInPlay === false) return null;
  if (e.kind === "estimate_declared" && facts.estimatePromisedUnfulfilled) return { action: "estimate_sheet", kind: "estimate" };
  // 2026-09-17 竹内（慶次事例）「物件募集見つかったら送る形なので、物件ピックアップ（複数）と物件オススメ（1件）がセットされる形となる」:
  //   「〇〇さんにオススメできるお部屋（の募集）を随時確認し、出次第お送りします」は「次第」が入るが、
  //   果たす手は決まっている（物件を送る）ので対象にする。どちらで送るかはスタッフが決める＝2つ目に物件オススメを並べる。
  //   実データ（365日・この型8件）: その後スタッフが送るのは物件資料（[画像]）4件・ピックアップ宣言1件で、確認結果の報告は0件
  if (e.kind === "pickup_declared" && facts.pickupPromisedUnfulfilled && e.detail?.watch === true) {
    return { action: "property_send", kind: "pickup", alt: "property_recommendation" };
  }
  if (e.kind === "pickup_declared" && facts.pickupPromisedUnfulfilled && !/次第/.test(e.evidence ?? "")) return { action: "property_send", kind: "pickup" };
  if (e.kind === "confirmation_promised" && facts.confirmationPromisedUnfulfilled && opts.customerRequestedCheck
    && !/割引|交渉/.test(e.detail?.object ?? "")
    // 申込の進捗（番手・お部屋止め・お申込完了・審査）の確認は 物件確認した ではない（カイナ事例の誤アナウンス）
    && !APPLY_PROGRESS_CHECK_RE.test(e.detail?.object ?? "")
    && !APPLY_PROGRESS_CHECK_RE.test(last.text ?? "")) return { action: "property_check_result", kind: "check" };
  return null;
}
