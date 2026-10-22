// app/lib/aix-catalog-learned.ts — 生成物（scripts/learn-aix-meanings.ts が作る・手で直さない）
// 作った時: 2026-10-22 11:37 JST・aix_usage_logs 2588件（2026-06-26〜）・竹内基準（竹内さんの送信 messages.staff_writer='takeuchi' と定義・設計知見）だけで意味を作る
// お手本は伏せた文だけ（お客様の名前・電話・住所・物件名・URL は出さない）。needsOwnerGold＝竹内さんのお手本が 3 未満（竹内さんに聞く）
import type { LearnedMeaning } from "./aix-meaning-learn";

export const AIX_LEARNED_GENERATED_AT = "2026-10-22 11:37";
export const AIX_LEARNED: Readonly<Record<string, LearnedMeaning>> = {
  "property_check_result/available": {
    "key": "property_check_result/available",
    "purpose": "送る情報: 管理会社に確認した募集中の結果（＋最大限割引の御見積書を同封）／使う時: 確認の約束の後・募集中だった",
    "writeContains": [
      "御見積書（88%）",
      "募集中の結果（85%）",
      "号室・部屋数（79%）",
      "募集終了の結果（45%）"
    ],
    "structure": {
      "uke": 21,
      "amount": 6,
      "promise": 27,
      "appeal": 42,
      "close": 0
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（27%）"
    ],
    "before": [
      "物件の共有（67%）"
    ],
    "exemplars": [
      "YUMAさんご連絡遅くなり申し訳ございません。\n\nお送り頂きましたお部屋の募集状況を確認致しましたところ、2枚目のセレニテフラン難波1501号室は現在募集中のお部屋となります！！\n\n初期費用の御見積書も同封させて頂きましたので、お手隙の際にご査収ください😌！！",
      "YUMAさんお送り頂きました物件の募集状況確認させて頂きました！！\n\n・Casa alivio 203号室（1枚目）\n・コウ　ラニカイ　エヴァ 105号室\n（2枚目3枚目の別のお部屋となります）\n\n現在募集中となっております！！\nお送り頂きましたコウ　ラニカイ　エヴァはこちらの105号室のみ募集しております！！\n\n初期費用の御見積書同封させて頂きました😊！！\nお手隙の際にご査収ください😌！！",
      "YUMAさんお世話になっております！！\nお送り頂きました3件のお部屋、管理会社に確認させて頂きましたところ現在すべて募集中となっております😊！！\n\n初期費用の御見積書同封させて頂きました！！\nお手隙の際にご査収ください😌！！"
    ],
    "counts": {
      "owner": 33,
      "all": 271,
      "misPressStaff": 7,
      "misPressOwner": 3
    },
    "needsOwnerGold": false,
    "kb": [
      "c18a0d32"
    ]
  },
  "property_check_result/alternative": {
    "key": "property_check_result/alternative",
    "purpose": "送る情報: 聞かれた部屋は満室・同じ建物の別の部屋が募集中という結果／使う時: 聞かれた部屋は満室だが同じ建物の別の部屋が募集中（同じ間取り／違う間取り）",
    "writeContains": [
      "募集中の結果（100%）",
      "御見積書（67%）",
      "号室・部屋数（67%）"
    ],
    "structure": {
      "uke": 33,
      "amount": 33,
      "promise": 0,
      "appeal": 33,
      "close": 0
    },
    "nextStep": [
      "AIX 物件ピックアップした（33%）",
      "AIX 見積書送る（33%）",
      "AIX 物件オススメ（1件特にオススメ）（33%）"
    ],
    "before": [
      "物件の質問（67%）",
      "物件の共有（33%）"
    ],
    "exemplars": [
      "YUMAさんお世話になっております！！\nお送り頂きましたお部屋確認させて頂きましたところジュネーゼグラン難波ミラージュとなります！！\nこちらのお部屋で現在募集しているお部屋の中で最も家賃を抑えられるお部屋がこちらの501号室となります！\nお手隙の際にご査収ください😌！！",
      "ブランズタワー大阪本町、他の階のお部屋\nこちらの701号室が今月末退去予定で募集中と\nなりますが、礼金600,000円必要となり初期費用がかなり必要となるお部屋となります！！\n\n701号室の初期費用の御見積書同封させて頂きました！YUMAさんお手隙の際にご査収ください😌！！",
      "お世話になっております！！\n\nお送り頂きましたエスリードレジデンス　ザ・グラン南堀江のお部屋ですが確認しましたところ募集終了しておりました！！\n\n別の間取り（41.67㎡）となりますが\nエスリードレジデンス　ザ・グラン南堀江で現在募集中のお部屋が御座いますので、最大限割引しました御見積書と併せてお送りさせて頂きました！！\nお手隙の際にご査収ください！！"
    ],
    "counts": {
      "owner": 3,
      "all": 9,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_check_result/unavailable": {
    "key": "property_check_result/unavailable",
    "purpose": "送る情報: 管理会社に確認した募集終了の結果／使う時: 確認の約束の後・募集が終わっていた（見積書を作ろうとして終わっていた時も）",
    "writeContains": [
      "募集終了の結果（100%）"
    ],
    "structure": {
      "uke": 13,
      "amount": 0,
      "promise": 33,
      "appeal": 13,
      "close": 21
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（38%）",
      "AIX 物件ピックアップした（29%）"
    ],
    "before": [
      "物件の共有（63%）",
      "お礼・了承（29%）"
    ],
    "exemplars": [
      "YUMAさんお送り頂きました物件3件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！",
      "お送り頂きました物件につきまして募集状況確認させて頂きましたところ、こちらテン・フォーティと言う物件となりますが、掲載のお部屋が現在募集に出ていないお部屋となっております！！",
      "YUMAさんお送り頂きましたBLDK THATER 9階のお部屋について募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております😌！！"
    ],
    "counts": {
      "owner": 24,
      "all": 58,
      "misPressStaff": 2,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": [
      "c18a0d32"
    ]
  },
  "property_check_result/exclusive": {
    "key": "property_check_result/exclusive",
    "purpose": "送る情報: 専任物件で弊社から紹介できないという結果／使う時: 専任のため弊社でご紹介できない",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/move_in_date": {
    "key": "property_check_result/move_in_date",
    "purpose": "送る情報: 退去日から計算した入居可能日（資料の画像）／使う時: 退去日から入居可能日を計算して送る（物件資料の画像）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/interior_photo": {
    "key": "property_check_result/interior_photo",
    "purpose": "送る情報: 手元の室内写真・室内イメージ URL／使う時: 室内の写真を頼まれ、頼まれた物件の室内イメージが手元にある",
    "writeContains": [
      "室内写真（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 0,
      "promise": 0,
      "appeal": 0,
      "close": 0
    },
    "nextStep": [
      "AIX 見積書送る（33%）"
    ],
    "before": [
      "物件の質問（50%）"
    ],
    "exemplars": [
      "（室内イメージ）\n（URL）"
    ],
    "counts": {
      "owner": 6,
      "all": 7,
      "misPressStaff": 0,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_check_result/other_room_check": {
    "key": "property_check_result/other_room_check",
    "purpose": "送る情報: 同じ建物の別の部屋・別の間取りの有無／使う時: 同じ建物の別の部屋・別の間取りを聞かれた（ある／ない）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_availability": {
    "key": "property_check_result/mgmt_availability",
    "purpose": "送る情報: 管理会社に聞いた募集状況（募集している／終了）／使う時: 管理会社に募集状況を聞いた（募集している／募集終了した）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 2,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/vacate_date": {
    "key": "property_check_result/vacate_date",
    "purpose": "送る情報: 管理会社に聞いた退去予定日／使う時: 退去予定日を管理会社に聞いた",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_move_in": {
    "key": "property_check_result/mgmt_move_in",
    "purpose": "送る情報: 管理会社に聞いた入居可能日・希望日で入れるか／使う時: 募集中と分かっているお部屋の入居可能日・希望日で入れるか",
    "writeContains": [
      "入居日・退去日（100%）",
      "申込（67%）",
      "内訳（67%）",
      "号室・部屋数（67%）"
    ],
    "structure": {
      "uke": 33,
      "amount": 0,
      "promise": 0,
      "appeal": 67,
      "close": 0
    },
    "nextStep": [
      "お客様: 申込・審査（33%）",
      "AIX 物件ピックアップした（33%）",
      "AIX 申込へ！（33%）"
    ],
    "before": [
      "物件の質問（67%）",
      "申込・審査（33%）"
    ],
    "exemplars": [
      "お世話になっております！！\nララプレイス難波シエール402号室ご入居日、確認しましたところ審査と契約書類準備の為\n最短で9月下旬（9月20日頃）にご入居出来る予定となります！！\nYUMAさん良ければ先にお申込みでお部屋を抑えてから内覧もできます！！\nお申込みはいかがでしょうか😌！！",
      "YUMAさんお世話になっております！！\nブランドール新大阪PARKレジデンス811号室管理会社に確認しましたところ\n7月20日退去予定の為\n最短で8月中旬にご入居出来る予定となります！！\nYUMAさん良ければ先にお申込みでお部屋を抑えてからご内覧もできます😊！！\nよろしければお申し込みしお部屋抑えるのは如何でしょうか！！"
    ],
    "counts": {
      "owner": 3,
      "all": 4,
      "misPressStaff": 0,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_check_result/mgmt_initial_cost": {
    "key": "property_check_result/mgmt_initial_cost",
    "purpose": "送る情報: 管理会社・代表・オーナーとの初期費用の交渉の結果（礼金・消臭代を外せるか 等）／使う時: 管理会社に初期費用の**交渉**（礼金・消臭代を外せるか等）をした結果。費用を知りたいだけの依頼は見積書送る",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 4,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "76212115"
    ]
  },
  "property_check_result/mgmt_proxy": {
    "key": "property_check_result/mgmt_proxy",
    "purpose": "送る情報: 代理契約の可否（管理会社の回答）／使う時: 代理契約の可否（可能／不可）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "4696868e"
    ]
  },
  "property_check_result/mgmt_lifeline": {
    "key": "property_check_result/mgmt_lifeline",
    "purpose": "送る情報: ライフラインの指定・連絡先（管理会社の回答）／使う時: ライフライン（電気・ガス・水道）の指定の有無と連絡先を管理会社に確認した結果。お客様に聞かれたら先に「ライフラインのお手続きにつきましては別途ご案内させて頂きます」と約束→答えをここから（2026-10-18 竹内さん 10/18）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_two_person": {
    "key": "property_check_result/mgmt_two_person",
    "purpose": "送る情報: 二人入居の可否（管理会社の回答・2026-10-18）／使う時: 二人入居の可否（可能／不可）。お客様に聞かれたら先に「物件ごとに違うので管理会社に確認させて頂きます」と約束→答えをここから（2026-10-18 竹内さん 10/16）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "4696868e"
    ]
  },
  "property_check_result/mgmt_guarantor": {
    "key": "property_check_result/mgmt_guarantor",
    "purpose": "送る情報: 管理会社に聞いた保証会社・保証人・審査の条件／使う時: 募集中と分かっているお部屋の保証会社・保証人・審査の条件",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 2,
      "all": 2,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_screening": {
    "key": "property_check_result/mgmt_screening",
    "purpose": "送る情報: 管理会社・保証会社に確認した審査の見込みと必要書類／使う時: 事情（名義・保証人なし・職業・国籍）の審査の相談に確認を約束した後",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_application_status": {
    "key": "property_check_result/mgmt_application_status",
    "purpose": "送る情報: 管理会社に確認したほかの方の申込の有無・何番手・1番手の審査の状況／使う時: 「何人待ち」「申込入ってますか」を管理会社に確認した結果（何番手・繰り上がり・申込への誘導）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_company": {
    "key": "property_check_result/mgmt_company",
    "purpose": "送る情報: 資料・管理会社で確かめた管理会社の名前・連絡先／使う時: 管理会社そのもの（名前・どこ・連絡先）を聞かれた。資料・管理会社で確かめた名前を送る（2026-09-30 竹内「管理会社の名前は『確認した』から送る」）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_parking": {
    "key": "property_check_result/mgmt_parking",
    "purpose": "送る情報: 管理会社に聞いた駐車場の有無・料金・空き／使う時: 物件の駐車場・バイク置き場の有無・料金・空き（中で駐車場／バイク置き場を選ぶ）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 3,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_pet": {
    "key": "property_check_result/mgmt_pet",
    "purpose": "送る情報: 管理会社に聞いたペットの可否・条件／使う時: ペット可否・条件",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "0dab071b"
    ]
  },
  "property_check_result/mgmt_equipment": {
    "key": "property_check_result/mgmt_equipment",
    "purpose": "送る情報: 管理会社に聞いた設備の有無／使う時: 設備の有無（エアコン・洗濯機置場 等）",
    "writeContains": [
      "設備（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 0,
      "promise": 100,
      "appeal": 0,
      "close": 33
    },
    "nextStep": [
      "AIX 申込へ！（67%）",
      "お客様: お礼・了承（33%）"
    ],
    "before": [
      "お礼・了承（33%）",
      "物件の共有（33%）",
      "その他（33%）"
    ],
    "exemplars": [
      "サンメゾンの設備状況につきまして管理会社へ確認させて頂きました！！\nリフォーム業者が16日まで夏季休暇となっており、壁紙・バスルーム・エアコン設置場所・和室の洋室変更・サッシの詳細につきましては17日以降に正確な内容が分かるとのことです！！サンメゾンの状況につきまして17日に再度催促させて頂き、改めて確認しご連絡させて頂きます！！",
      "YUMAさんお世話になっております！！\n昨日はお時間頂きありがとうございました！！\n\nサンメゾンの設備状況につきまして管理会社担当者へ確認させて頂きました！！\nエアコン・温水洗浄便座・インターフォンが新しく新設されます！！\nYUMAさんお気に召されましたらお申込みしお部屋抑えさせて頂きます！！",
      "YUMAさんお世話になっております！！\nセレコート平野 602号室の設備状況につきまして管理会社へ確認させて頂きました！！\nエアコンは現状設置されていないお部屋となります！！\n\nYUMAさんのご条件に合ったお部屋募集出次第お送りさせてます！！\n何卒よろしくお願い致します！！"
    ],
    "counts": {
      "owner": 3,
      "all": 6,
      "misPressStaff": 0,
      "misPressOwner": 3
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_check_result/mgmt_contract_terms": {
    "key": "property_check_result/mgmt_contract_terms",
    "purpose": "送る情報: 管理会社に確認した短期解約の違約金・クリーニング代・フリーレント（物件ごと）／使う時: 短期解約の違約金・クリーニング代・フリーレントを管理会社に確認した結果（物件ごと）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_rent_negotiation": {
    "key": "property_check_result/mgmt_rent_negotiation",
    "purpose": "送る情報: 家賃の値下げを交渉した結果／使う時: 頼まれて家賃の値下げを交渉した結果（下がった／下がらなかった）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/mgmt_surroundings": {
    "key": "property_check_result/mgmt_surroundings",
    "purpose": "送る情報: 現地で見た・管理会社に聞いた日当たり・音・周辺の様子／使う時: 日当たり・音・周辺の様子を現地で見た／管理会社に聞いた結果",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/nearby_parking": {
    "key": "property_check_result/nearby_parking",
    "purpose": "送る情報: 近隣の月極駐車場（名前・距離・料金・空き）／使う時: 近くの月極駐車場（名前・距離・料金・空き）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/owner_other": {
    "key": "property_check_result/owner_other",
    "purpose": "送る情報: オーナーに確認した内容と結果／使う時: オーナーに確認した内容と結果",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_check_result/room_vacancies": {
    "key": "property_check_result/room_vacancies",
    "purpose": "送る情報: 募集一覧で見た建物の募集中の号室・間取り・家賃／使う時: 建物の何部屋・どの号室が空いているかを聞かれた",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_send/normal": {
    "key": "property_send/normal",
    "purpose": "送る情報: スタッフが検索して選んだ物件（資料）／使う時: まだ物件を送っていないお客様に初めて送る（初回まとめ）",
    "writeContains": [
      "物件の束（98%）",
      "1件の推し（67%）"
    ],
    "structure": {
      "uke": 16,
      "amount": 40,
      "promise": 17,
      "appeal": 67,
      "close": 0
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（79%）"
    ],
    "before": [
      "お礼・了承（48%）"
    ],
    "exemplars": [
      "YUMAさん梅田周辺エリアに通いやすい地域、全域から家賃9万円以内・築10年以内のYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\n審査面も通過出来るようサポートさせて頂きますので、お気に召されたお部屋はお任せください！！\n\nお手隙の際にご査収ください😌！！",
      "YUMAさんお探しの地域全域から、管理費込み15〜16万円以内・1LDK・ペット飼育可能・敷金礼金なしでYUMAさんにオススメできるお部屋をピックアップさせて頂きました😊！！\nお手隙の際にご査収ください😌！！",
      "YUMAさん\n寝屋川市周辺全域からYUMAさんご希望のご条件に近いお部屋全てピックアップさせて頂きました😊！！\nお手隙の際にご査収ください😌！！"
    ],
    "counts": {
      "owner": 58,
      "all": 179,
      "misPressStaff": 4,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_send/new_arrival": {
    "key": "property_send/new_arrival",
    "purpose": "送る情報: スタッフが検索して選んだ物件（資料）／使う時: 前に送った後の新着（追客・他の物件も見たい）",
    "writeContains": [
      "物件の束（96%）",
      "1件の推し（68%）",
      "新着（40%）"
    ],
    "structure": {
      "uke": 20,
      "amount": 24,
      "promise": 20,
      "appeal": 68,
      "close": 0
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（60%）"
    ],
    "before": [
      "お礼・了承（40%）",
      "なし（20%）"
    ],
    "exemplars": [
      "YUMAさん夜分遅くに失礼致します！！\n同じ条件で3DKのお部屋をJR沿線を中心に家賃9万円以内・鉄筋コンクリート造でYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\nお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！\n\nお手隙の際にご査収ください😌！！",
      "YUMAさん難波・桜川・大正周辺全域から家賃6〜7万円程・1K・バストイレ別のご条件で、敷金礼金なしのお部屋2件ピックアップさせて頂きました！！\n\n初期費用上限15万円以下のご希望に沿って、初期費用を抑えられるお部屋をお選びしております😊！！\n\nお手隙の際にご査収ください😌！！",
      "お世話になっております！！\n引扉の物件でペット飼育可能・1LDKのお部屋で現在募集中のお部屋を全てピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！"
    ],
    "counts": {
      "owner": 25,
      "all": 221,
      "misPressStaff": 12,
      "misPressOwner": 7
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_send/widen": {
    "key": "property_send/widen",
    "purpose": "送る情報: スタッフが検索して選んだ物件（資料）／使う時: 希望どおりが無く条件を広げて探した・お客様が条件を広げた",
    "writeContains": [
      "物件の束（94%）"
    ],
    "structure": {
      "uke": 17,
      "amount": 22,
      "promise": 17,
      "appeal": 28,
      "close": 0
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（61%）",
      "AIX 見積書送る（22%）"
    ],
    "before": [
      "お礼・了承（39%）",
      "条件（22%）"
    ],
    "exemplars": [
      "お世話になっております！！\n\n心斎橋付近全域からタワーマンションのお部屋でご条件に近いお部屋全てピックアップさせて頂きました！！\nお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！\nお手隙の際にご査収ください😌！！",
      "左側エリア全域から、現在募集中のお部屋\n全て確認させて頂きましたところ白基調のお部屋でYUMAさんご条件に近いお部屋御座いまんでした。\n白基調ではないですが、ご条件に近いお部屋ピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！",
      "お世話になっております！！\n\n中央区・浪速区全域から家賃のご上限を上げたご条件で、YUMAさんにオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！"
    ],
    "counts": {
      "owner": 18,
      "all": 57,
      "misPressStaff": 4,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_send/alternative": {
    "key": "property_send/alternative",
    "purpose": "送る情報: スタッフが検索して選んだ物件（資料）／使う時: 気に入った物件が募集終了・紹介不可の代わり（物件確認した→物件なかった の後）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 2,
      "all": 4,
      "misPressStaff": 0,
      "misPressOwner": 2
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_recommendation/新規ピックアップ": {
    "key": "property_recommendation/新規ピックアップ",
    "purpose": "送る情報: スタッフが選んだ1件（資料の画像）とその推しどころ／使う時: まだ物件を送っていない（初回の）お客様に1件だけ勧める（竹内さん 4%）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 13,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_recommendation/新着1件": {
    "key": "property_recommendation/新着1件",
    "purpose": "送る情報: スタッフが選んだ1件（資料の画像）とその推しどころ／使う時: 前に物件を送った後に新しく募集に出た1件を勧める（追客・束から1時間超・竹内さん 60%）",
    "writeContains": [
      "1件の推し（100%）",
      "金額（91%）",
      "設備（91%）",
      "号室・部屋数（88%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 91,
      "promise": 0,
      "appeal": 100,
      "close": 0
    },
    "nextStep": [
      "AIX 物件確認した（募集状況）／確認した（条件・交渉）（31%）",
      "返事なし（2日）（22%）"
    ],
    "before": [
      "お礼・了承（34%）",
      "なし（34%）"
    ],
    "exemplars": [
      "🌟ノイヴェル野里 105号室\n\n1件独立洗面台でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n\n（オススメポイント）\n・間取り：1K（洋室7.5帖）\n・阪神本線「姫島」徒歩7分／JR東西線「御幣島」徒歩9分\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・独立洗面台あり\n・オートロック付き\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！",
      "🌟プレサンス天王寺デルニエ 1006号室\n\n（オススメポイント）\n・家賃96,110円・管理費8,890円（合計105,000円）\n・間取り：1LDK（リビング10.5帖、洋室4.7帖）\n・専有面積29.64㎡\n・御堂筋線「天王寺」徒歩12分\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・2025年6月築で築年数浅く、室内が綺麗なお部屋です！！\n・2口コンロ・オートロック・浴室乾燥機・追い焚き機能付き\n・インターネット無料で毎月の通信費も節約出来ます！！\n\n🌟最大限割引しました初期費用の御見積…",
      "🌟Vinoプレジオ本町 1312号室\n\n（オススメポイント）\n・家賃153,000円・管理費12,000円（合計165,000円）\n・間取り：1LDK（リビング10.01帖、洋室6.37帖）\n（住所の行）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・2023年8月築で築年数浅く\n・インターネット使用料不要\n・浴室乾燥機・追い焚き・シャワートイレなど水回り設備が充実\n・宅配ボックス・オートロック・防犯カメラで安心\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！"
    ],
    "counts": {
      "owner": 32,
      "all": 132,
      "misPressStaff": 4,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_recommendation/継続ピックアップ": {
    "key": "property_recommendation/継続ピックアップ",
    "purpose": "送る情報: スタッフが選んだ1件（資料の画像）とその推しどころ／使う時: AIX【物件ピックアップした】で複数件送った直後（1時間以内）に、続けてその中から1件を推す（竹内さん 23%・「お送りさせて頂きましたお部屋の中でも」）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 2,
      "all": 4,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_recommendation/条件広げピックアップ": {
    "key": "property_recommendation/条件広げピックアップ",
    "purpose": "送る情報: スタッフが選んだ1件（資料の画像）とその推しどころ／使う時: 条件を広げた束（物件ピックアップした→条件を広げた）を送った直後に、その中から1件を推す（竹内さん 6%）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 2,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_recommendation/代替ピックアップ": {
    "key": "property_recommendation/代替ピックアップ",
    "purpose": "送る情報: スタッフが選んだ1件（資料の画像）とその推しどころ／使う時: 気に入った・聞いた物件が募集終了・紹介不可だった（物件確認した→物件なかった）後に代わりの1件（竹内さん 6%）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_recommendation/現状伝えて1件": {
    "key": "property_recommendation/現状伝えて1件",
    "purpose": "送る情報: スタッフが選んだ1件（資料の画像）とその推しどころ／使う時: ご条件どおりの空室が無い・ご希望エリアに無い現状を1文で伝えてから、退去予定・周辺の1件を勧める（まれ）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "estimate_sheet/single": {
    "key": "estimate_sheet/single",
    "purpose": "送る情報: 管理会社の資料から作った御見積書の金額（最大限割引）／使う時: お部屋1件の御見積書",
    "writeContains": [
      "金額（100%）",
      "入居日・退去日（100%）",
      "号室・部屋数（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 100,
      "promise": 0,
      "appeal": 93,
      "close": 0
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（22%）"
    ],
    "before": [
      "費用（41%）",
      "物件の共有（35%）"
    ],
    "exemplars": [
      "【物件名】\n\n初期費用さらに\n🌟36,000円割引させて頂き\n初期費用：159,830円\n\nスモラなら一般的な不動産業者より96,270円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
      "【物件名】\n\n初期費用さらに\n🌟44,000円割引させて頂き\n初期費用：150,980円\n\nスモラなら一般的な不動産業者より103,720円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
      "【物件名】\n\n初期費用さらに\n🌟82,000円割引させて頂き\n初期費用：179,480円\n\nスモラなら一般的な不動産業者より227,520円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。"
    ],
    "counts": {
      "owner": 46,
      "all": 58,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": [
      "3f67fd3f",
      "5cb4bd2f"
    ]
  },
  "estimate_sheet/multi": {
    "key": "estimate_sheet/multi",
    "purpose": "送る情報: 管理会社の資料から作った御見積書の金額（最大限割引）／使う時: 2〜3件の御見積書を一度に",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 8,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "viewing_invite/通常": {
    "key": "viewing_invite/通常",
    "purpose": "送る情報: スタッフの空いている日時（内覧の候補日）・退去予定の部屋の内覧開始日／使う時: 内覧の希望（日時なし・今見られる部屋）に候補日を出す",
    "writeContains": [
      "内覧の日時（100%）",
      "号室・部屋数（63%）"
    ],
    "structure": {
      "uke": 75,
      "amount": 0,
      "promise": 88,
      "appeal": 25,
      "close": 0
    },
    "nextStep": [
      "AIX 待ち合わせ（63%）"
    ],
    "before": [
      "その他（38%）",
      "内覧（25%）"
    ],
    "exemplars": [
      "かしこまりました😊！！\n\n25日が予定埋まっておりまして\n28日以降にスプランディッド難波SOUTH 406号室お部屋ご案内させて頂きます！！\n\n直近ですと\n10/28(水) 15:00〜18:00\n10/29(木) 12:00〜14:00\n10/30(金) 13:00〜15:00にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか！！",
      "YUMAさんお世話になっております！！\nかしこまりました！！\n\nグランパシフィック桜川南902号室、お部屋ご案内させて頂きます😊！！\n\n直近ですと\n本日 10/19(月) 16:00〜18:30\n明日 10/20(火) 15:30〜17:30\n10/21(水) 12:00〜15:00にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！\n\nお部屋他にもオススメできるお部屋、引き続き新着でピックアップ出来次第お送りさせて頂きます！！",
      "かしこまりました！！\nレジェンドール心斎橋EAST 906号室ご案内させて頂きます😊！！\n\n直近ですと\n10/16(金) 12:00〜15:00\n10/17(土) 16:00〜18:30にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！"
    ],
    "counts": {
      "owner": 8,
      "all": 31,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "viewing_invite/退去予定物件": {
    "key": "viewing_invite/退去予定物件",
    "purpose": "送る情報: 管理会社に確認した退去予定の部屋の内覧開始日／使う時: 退去予定の部屋の内覧（確認の約束の後）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "viewing_invite/内覧日指定あり": {
    "key": "viewing_invite/内覧日指定あり",
    "purpose": "送る情報: スタッフの空いている日時（内覧の候補日）・退去予定の部屋の内覧開始日／使う時: お客様が初めて日時を指定した（候補日を出す前）",
    "writeContains": [
      "内覧の日時（100%）",
      "号室・部屋数（50%）"
    ],
    "structure": {
      "uke": 63,
      "amount": 0,
      "promise": 75,
      "appeal": 13,
      "close": 0
    },
    "nextStep": [
      "AIX 待ち合わせ（50%）"
    ],
    "before": [
      "内覧（75%）"
    ],
    "exemplars": [
      "はい！！\n本日17:00～18;30の間お部屋ご案内できます！！\nYUMAさんご都合如何でしょうか！！",
      "明日ご内覧のご対応可能です😊！！\n明日10/12(月) 11:00〜11:30・15:30〜17:30\nお部屋ご案内可能です！！\n\nYUMAさんご都合よろしいお時間御座いますでしょうか！！",
      "かしこまりました！！\nエスフィールド202号室お部屋ご案内させて頂きます！！\n\n今週の日曜日が予定埋まっておりまして\n土曜日(10日）ですと16:00～18:00ご案内できます！！\n\n平日ですとYUMAsさんご希望のお日にちでお時間調整させていただきます！！\nYUMAさんご都合よろしいお時間御座いますでしょうか😌！！"
    ],
    "counts": {
      "owner": 8,
      "all": 22,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "viewing_invite/日程変更": {
    "key": "viewing_invite/日程変更",
    "purpose": "送る情報: スタッフの空いている日時（内覧の候補日）・退去予定の部屋の内覧開始日／使う時: 決まった内覧の日時を変える",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 1,
      "misPressStaff": 1,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "meeting_place": {
    "key": "meeting_place",
    "purpose": "送る情報: 内覧の確定（日時）と待ち合わせの場所・住所（番地まで）／使う時: 内覧の候補日を出した後、お客様が日時を選んだ・了承した",
    "writeContains": [
      "待ち合わせ（100%）",
      "内覧の日時（75%）"
    ],
    "structure": {
      "uke": 93,
      "amount": 0,
      "promise": 88,
      "appeal": 5,
      "close": 95
    },
    "nextStep": [],
    "before": [
      "お礼・了承（38%）",
      "物件の質問（28%）"
    ],
    "exemplars": [
      "かしこまりました！！\n10/28（水）ご案内させて頂きます！！\n\n10/28 17:00にスプランディッド難波SOUTH \n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n（住所の行）",
      "かしこまりました！！\n10/29（木）ご案内させて頂きます！！\n\n10/29 15:00にグランパシフィック桜川南 902号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n（住所の行）",
      "かしこまりました！！\n明日12:00にお部屋ご案内させて頂きます！！\n\n10/16 12:00にレジェンドール心斎橋EAST \n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n（住所の行）"
    ],
    "counts": {
      "owner": 40,
      "all": 109,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "application_push/push": {
    "key": "application_push/push",
    "purpose": "送る情報: 申込の手続き（申込書の様式・必要書類の案内）／使う時: まだ決めていないお客様の申込の後押し（退去予定の先押さえ・部屋を抑えて内覧）",
    "writeContains": [
      "申込（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 0,
      "promise": 100,
      "appeal": 0,
      "close": 33
    },
    "nextStep": [
      "返事なし（2日）（100%）"
    ],
    "before": [
      "物件の質問（33%）",
      "申込・審査（33%）",
      "なし（33%）"
    ],
    "exemplars": [
      "YUMAさんお世話になっております！！\n\n現在お申込み完了してない状態となります！！\n\nお送り頂き次第、お部屋お申込みしお部屋抑えさせて頂きます！！\nご不明点ございましたらいつでもお気軽にご連絡ください！！",
      "YUMAさんお世話になっております！！\n\n現在まだお申込完了していない状況となります！！\nご不明点等ございましたら、いつでもお気軽にご連絡ください😊！！\nお気に召されましたらお申込みさせて頂き、お部屋抑えさせて頂きますので何卒よろしくお願い致します！！",
      "YUMAさんお世話になっております！！\n周辺環境如何でしたでしょうか！！\nお気に召されましたら、いつでもお申込みでお部屋抑えさせて頂きますのでお気軽にご連絡ください！！\n他にも気になる点ございましたら何なりとお申し付けください！！"
    ],
    "counts": {
      "owner": 3,
      "all": 8,
      "misPressStaff": 0,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "application_push/confirm": {
    "key": "application_push/confirm",
    "purpose": "送る情報: 申込の手続き（申込書の様式・必要書類の案内）／使う時: お客様が申込を決めた（確定のご連絡と次の手順）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 4,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "application_push/format": {
    "key": "application_push/format",
    "purpose": "送る情報: 申込の手続き（申込書の様式・必要書類の案内）／使う時: 申込を決めた後に申込書（記入フォーマット）を送る",
    "writeContains": [
      "申込フォーマット（100%）",
      "申込（100%）",
      "駐車場（100%）",
      "ペット（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 0,
      "promise": 0,
      "appeal": 0,
      "close": 0
    },
    "nextStep": [
      "AIX 物件ピックアップした（24%）"
    ],
    "before": [
      "お礼・了承（47%）",
      "申込・審査（41%）"
    ],
    "exemplars": [],
    "counts": {
      "owner": 17,
      "all": 75,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "application_push/docs_request": {
    "key": "application_push/docs_request",
    "purpose": "送る情報: 申込の手続き（申込書の様式・必要書類の案内）／使う時: 不足している書類の依頼",
    "writeContains": [
      "申込（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 0,
      "promise": 100,
      "appeal": 0,
      "close": 33
    },
    "nextStep": [
      "お客様: 物件の共有（67%）",
      "AIX 見積書送る（33%）"
    ],
    "before": [
      "申込・審査（67%）",
      "物件の共有（33%）"
    ],
    "exemplars": [],
    "counts": {
      "owner": 3,
      "all": 3,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "followup_revive/apply_supplement": {
    "key": "followup_revive/apply_supplement",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 申込の書類・情報が届かないまま止まった",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "followup_revive/search_continue": {
    "key": "followup_revive/search_continue",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 物件を送った後に返信が3日以上止まった（お部屋探しを続けているか）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "acknowledge_check/daihyo_initial_cost": {
    "key": "acknowledge_check/daihyo_initial_cost",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 御見積書の後に「更に安くならないか」と聞かれた → 代表に初期費用の更なる割引を確認・交渉する約束（お客様あて）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "a1435722"
    ]
  },
  "acknowledge_check/kanri_boshu": {
    "key": "acknowledge_check/kanri_boshu",
    "purpose": "送る情報: 定型の文・フォーム／使う時: （押下なし）管理会社に募集状況を確認する",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "condition_hearing/generate": {
    "key": "condition_hearing/generate",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 初回でまだ物件を送っておらず、エリアと家賃の両方がそろっていない",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "condition_hearing/conv_match": {
    "key": "condition_hearing/conv_match",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 初回でまだ物件を送っておらず、エリアと家賃の両方がそろっていない",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "condition_hearing/form_only": {
    "key": "condition_hearing/form_only",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 初回でまだ物件を送っておらず、エリアと家賃の両方がそろっていない",
    "writeContains": [
      "条件ヒアリング（100%）",
      "駐車場（100%）",
      "ペット（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 0,
      "promise": 0,
      "appeal": 0,
      "close": 0
    },
    "nextStep": [
      "AIX 物件ピックアップした（67%）",
      "返事なし（2日）（33%）"
    ],
    "before": [
      "その他（33%）",
      "お礼・了承（33%）"
    ],
    "exemplars": [
      "（YUMAさんご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃（管理費込み）\n③ご希望間取り\n④ご希望築年数\n⑤ご希望エリア・最寄り駅\n⑥駅からの徒歩分数\n⑦初期費用ご予算\n⑧その他こだわり条件（ペット・保証人・駐車場等）\n⑨ご入居人数",
      "（ご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃（管理費込み）\n③ご希望間取り\n④ご希望築年数\n⑤ご希望エリア・最寄り駅\n⑥駅からの徒歩分数\n⑦初期費用ご予算\n⑧その他こだわり条件（ペット・保証人・駐車場等）\n⑨ご入居人数"
    ],
    "counts": {
      "owner": 6,
      "all": 11,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "cost_explain/fee": {
    "key": "cost_explain/fee",
    "purpose": "送る情報: 貸主からの報酬（AD）と還元額／使う時: 費用の安さを不審に思われた・安い理由を聞かれた",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "cost_explain/no_fee": {
    "key": "cost_explain/no_fee",
    "purpose": "送る情報: 貸主からの報酬（AD）と還元額／使う時: 費用の安さを不審に思われた・安い理由を聞かれた",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "cost_explain/mechanism": {
    "key": "cost_explain/mechanism",
    "purpose": "送る情報: 貸主からの報酬（AD）と還元額／使う時: 費用の安さを不審に思われた・安い理由を聞かれた",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "cost_breakdown": {
    "key": "cost_breakdown",
    "purpose": "送る情報: 送った御見積書の内訳（項目と金額）／使う時: 御見積書の後に初期費用の中身（何が含まれるか・家賃だけで入居できるか）を聞かれた",
    "writeContains": [
      "金額（100%）",
      "1件の推し（100%）",
      "入居日・退去日（100%）",
      "号室・部屋数（67%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 100,
      "promise": 33,
      "appeal": 100,
      "close": 0
    },
    "nextStep": [
      "AIX 物件ピックアップした（33%）",
      "AIX 申込へ！（33%）",
      "返事なし（2日）（33%）"
    ],
    "before": [
      "条件（67%）",
      "費用（33%）"
    ],
    "exemplars": [
      "YUMAさんご連絡頂きありがとうございます！！\n\nアーバネックス堺筋本町501号室の初期費用170,480円には、前家賃（翌月分家賃167,500円＋共益費13,000円）が含まれている金額となります😊！！\nご入居日によって日割家賃が発生致しますが、1日ご入居の場合はかかりませんので、初期費用を出来る限り抑える場合は1日でのご入居がオススメです😌！！",
      "YUMAさんお世話になっております！！\n\n初期費用翌月分の前家賃込みとなります！！\n初期費用137,980円に鍵交換代・賃貸保証料・火災保険・仲介手数料まで含めさせて頂いております😊！！\n\n※ご入居日によって日割家賃が発生致しますが、1日ご入居の場合はかかりませんので、初期費用を出来る限り抑える場合は1日でのご入居がオススメです😌！！\n\nYUMAさんご不明点ございましたらいつでもお気軽にご連絡ください！！",
      "YUMAさんお世話になっております！！\nレシオス阿倍野ヴィータ303号室は初期費用39,300円は翌月分の家賃を支払った費用となります！！\n\n別途必要な費用はご入居日によって日割家賃が発生いたします！\n※1日ご入居の場合は日割家賃は発生いたしません）\n\n南向き・5階以上・御堂筋線沿線のご条件でも改めてYUMAさんにオススメできるお部屋ピックアップさせて頂きます！！"
    ],
    "counts": {
      "owner": 3,
      "all": 3,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "guarantor_info": {
    "key": "guarantor_info",
    "purpose": "送る情報: 物件ごとの保証会社名・種類（管理会社に確認した物）／使う時: 保証会社そのもの（どこか・種類・通りやすさ）を聞かれた・複数の物件の保証会社を伝える",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "3b455d67"
    ]
  },
  "phone_call": {
    "key": "phone_call",
    "purpose": "送る情報: 定型の文・フォーム／使う時: お客様が電話で話したい（電話の依頼）",
    "writeContains": [
      "電話（100%）",
      "審査（43%）"
    ],
    "structure": {
      "uke": 14,
      "amount": 0,
      "promise": 14,
      "appeal": 0,
      "close": 29
    },
    "nextStep": [
      "AIX 申込へ！（43%）"
    ],
    "before": [
      "申込・審査（43%）",
      "物件の質問（29%）"
    ],
    "exemplars": [
      "YUMAさん\nお世話になっております！！\n\nかしこまりました！！\n本日10:00～18:00\nご都合よろしいお時間にお電話おかけください！！\n何卒よろしくおねがい致します！！",
      "審査無事通過する為に一度5分程お電話させて頂けますと幸いです！！\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します😊！！",
      "YUMAさん　\nお手隙の際にこちらの電話をかけるボタンよりお電話お願い致します！！"
    ],
    "counts": {
      "owner": 7,
      "all": 24,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "phone_followup": {
    "key": "phone_followup",
    "purpose": "送る情報: 電話で話した内容／使う時: 電話の後のまとめ（スタッフが押す）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "zenryoku_support": {
    "key": "zenryoku_support",
    "purpose": "送る情報: スタッフが探した結果（条件に合うお部屋が今は無い）／使う時: 条件で探したが送れる物件が無かった時（新着が出次第送る約束）（10/08 竹内さん「進めて良い」）",
    "writeContains": [
      "新着（100%）",
      "全力サポート（100%）"
    ],
    "structure": {
      "uke": 25,
      "amount": 0,
      "promise": 100,
      "appeal": 25,
      "close": 75
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（25%）",
      "返事なし（2日）（25%）",
      "お客様: 費用（25%）"
    ],
    "before": [
      "お礼・了承（75%）",
      "その他（25%）"
    ],
    "exemplars": [
      "中津駅周辺を重点的に敷地内駐車場付きのお部屋でYUMAさんのご条件に合うお部屋の新着が出次第、お送りさせて頂きます！！\n何卒よろしくお願い致します😌！！\nご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！\n何卒よろしくお願い致します！！",
      "お世話になっております！！\nご意見お聞かせ頂きありがとうございます😌！！\n先ほど頂いたご感想も踏まえ、クローゼットの収納もしっかり確保出来るお部屋を新着中心にピックアップして改めてお送りさせて頂きます！！\nYUMAさんにぴったりのお部屋が見つかるまで全力でサポートさせて頂きます😊！！",
      "はい😊！！\n新着物件も随時確認させて頂き、YUMAさんにオススメ出来る新着のお部屋が募集に出次第お送りさせて頂きます！！\nご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます！何卒よろしくお願い致します！！"
    ],
    "counts": {
      "owner": 4,
      "all": 16,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": [
      "76212115",
      "3f67fd3f"
    ]
  },
  "greeting_viewing/before": {
    "key": "greeting_viewing/before",
    "purpose": "送る情報: 内覧の日時／使う時: 内覧の前（当日の朝・前日）の挨拶",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 9,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "6c38daca",
      "fca29a19",
      "a92b6655"
    ]
  },
  "greeting_viewing/after:apply": {
    "key": "greeting_viewing/after:apply",
    "purpose": "送る情報: 内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）／使う時: 内覧の後にお申込みでお部屋を抑える",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 9,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "greeting_viewing/after:apply_guide": {
    "key": "greeting_viewing/after:apply_guide",
    "purpose": "送る情報: 内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）／使う時: 内覧の後に気に入ったら申込を促す",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 1,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "greeting_viewing/after:confirm_estimate": {
    "key": "greeting_viewing/after:confirm_estimate",
    "purpose": "送る情報: 内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）／使う時: 内覧で出た確認事項を御見積書と一緒に送る",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "greeting_viewing/after:confirm_freeword": {
    "key": "greeting_viewing/after:confirm_freeword",
    "purpose": "送る情報: 内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）／使う時: 内覧で出た確認事項の答えを送る",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "greeting_viewing/after:search_new": {
    "key": "greeting_viewing/after:search_new",
    "purpose": "送る情報: 内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）／使う時: 内覧した物件が合わず新着を探す",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 6,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "greeting_viewing/after:search_expand": {
    "key": "greeting_viewing/after:search_expand",
    "purpose": "送る情報: 内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）／使う時: 内覧の後に条件を広げて探す",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "greeting_viewing/after:search_change": {
    "key": "greeting_viewing/after:search_change",
    "purpose": "送る情報: 内覧の日時（内覧前）／内覧に行ったスタッフが分かった事（内覧後）／使う時: 内覧の後に新しい条件で探す",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "property_search": {
    "key": "property_search",
    "purpose": "送る情報: 定型の文・フォーム／使う時: （文は送らない）拡張ツールで探す操作。お客様への最初の一手は約束の返信（2段）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 0,
      "all": 0,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_check_result": {
    "key": "property_check_result",
    "purpose": "送る情報: 管理会社に確認した募集中の結果（＋最大限割引の御見積書を同封）／使う時: 確認の約束の後・募集中だった",
    "writeContains": [
      "募集終了の結果（52%）",
      "号室・部屋数（43%）",
      "募集中の結果（42%）",
      "御見積書（40%）"
    ],
    "structure": {
      "uke": 17,
      "amount": 4,
      "promise": 29,
      "appeal": 27,
      "close": 9
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（26%）",
      "AIX 物件ピックアップした（21%）"
    ],
    "before": [
      "物件の共有（52%）",
      "お礼・了承（21%）"
    ],
    "exemplars": [
      "YUMAさんご連絡遅くなり申し訳ございません。\n\nお送り頂きましたお部屋の募集状況を確認致しましたところ、2枚目のセレニテフラン難波1501号室は現在募集中のお部屋となります！！\n\n初期費用の御見積書も同封させて頂きましたので、お手隙の際にご査収ください😌！！",
      "YUMAさんお送り頂きました物件の募集状況確認させて頂きました！！\n\n・Casa alivio 203号室（1枚目）\n・コウ　ラニカイ　エヴァ 105号室\n（2枚目3枚目の別のお部屋となります）\n\n現在募集中となっております！！\nお送り頂きましたコウ　ラニカイ　エヴァはこちらの105号室のみ募集しております！！\n\n初期費用の御見積書同封させて頂きました😊！！\nお手隙の際にご査収ください😌！！",
      "YUMAさんお世話になっております！！\nこちら管理会社に確認させて頂きましたところ、現在102号室のみ募集中となり他のお部屋は募集されていない形となります！！\nお手数おかけしますが何卒よろしくお願い致します！！"
    ],
    "counts": {
      "owner": 77,
      "all": 410,
      "misPressStaff": 9,
      "misPressOwner": 8
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "property_send": {
    "key": "property_send",
    "purpose": "送る情報: スタッフが検索して選んだ物件（資料）／使う時: まだ物件を送っていないお客様に初めて送る（初回まとめ）",
    "writeContains": [
      "物件の束（97%）",
      "1件の推し（60%）"
    ],
    "structure": {
      "uke": 18,
      "amount": 31,
      "promise": 18,
      "appeal": 62,
      "close": 0
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（73%）"
    ],
    "before": [
      "お礼・了承（48%）"
    ],
    "exemplars": [
      "YUMAさん夜分遅くに失礼致します！！\n同じ条件で3DKのお部屋をJR沿線を中心に家賃9万円以内・鉄筋コンクリート造でYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\nお気に召されたお部屋ご都合よろしいお日にちにご案内させて頂きます！！\n\nお手隙の際にご査収ください😌！！",
      "YUMAさん梅田周辺エリアに通いやすい地域、全域から家賃9万円以内・築10年以内のYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\n審査面も通過出来るようサポートさせて頂きますので、お気に召されたお部屋はお任せください！！\n\nお手隙の際にご査収ください😌！！",
      "YUMAさんお探しの地域全域から、管理費込み15〜16万円以内・1LDK・ペット飼育可能・敷金礼金なしでYUMAさんにオススメできるお部屋をピックアップさせて頂きました😊！！\nお手隙の際にご査収ください😌！！"
    ],
    "counts": {
      "owner": 110,
      "all": 542,
      "misPressStaff": 22,
      "misPressOwner": 11
    },
    "needsOwnerGold": false,
    "kb": [
      "f3623fee"
    ]
  },
  "property_recommendation": {
    "key": "property_recommendation",
    "purpose": "送る情報: スタッフが選んだ1件（資料の画像）とその推しどころ／使う時: まだ物件を送っていない（初回の）お客様に1件だけ勧める（竹内さん 4%）",
    "writeContains": [
      "1件の推し（100%）",
      "金額（93%）",
      "設備（81%）",
      "号室・部屋数（51%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 93,
      "promise": 1,
      "appeal": 100,
      "close": 0
    },
    "nextStep": [
      "返事なし（2日）（34%）"
    ],
    "before": [
      "なし（35%）",
      "お礼・了承（31%）"
    ],
    "exemplars": [
      "🌟ロンド・エーデルワイス 105号室\n\n（オススメポイント）\n・家賃100,000円・管理費10,000円（合計110,000円）\n・間取り：2LDK（リビング10.4帖、洋室6.0帖・洋室4.5帖）\n・専有面積47.23㎡\n・千日前線「南巽」徒歩11分\n・角部屋のお部屋です\n・浴室乾燥機・追い焚き・独立洗面台など水回り設備充実\n・敷地内駐車場あり（15,000円）\n・インターネット無料",
      "🌟ノイヴェル野里 105号室\n\n1件独立洗面台でYUMAさんにかなりオススメ出来るお部屋が募集に出ました！！\n\n（オススメポイント）\n・間取り：1K（洋室7.5帖）\n・阪神本線「姫島」徒歩7分／JR東西線「御幣島」徒歩9分\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・独立洗面台あり\n・オートロック付き\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！",
      "🌟ACT正雀(イタンジ最新) 102号室\n\n（オススメポイント）\n・家賃80,000円・管理費8,000円（合計88,000円）\n・間取り：1LDK（リビング8.4帖、洋室6.6帖）\n・敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n・新築\n・インターネット無料で毎月の通信費も節約出来ます！！\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！"
    ],
    "counts": {
      "owner": 288,
      "all": 825,
      "misPressStaff": 10,
      "misPressOwner": 4
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "estimate_sheet": {
    "key": "estimate_sheet",
    "purpose": "送る情報: 管理会社の資料から作った御見積書の金額（最大限割引）／使う時: お部屋1件の御見積書",
    "writeContains": [
      "金額（99%）",
      "入居日・退去日（99%）",
      "号室・部屋数（98%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 99,
      "promise": 1,
      "appeal": 98,
      "close": 0
    },
    "nextStep": [
      "AIX 物件オススメ（1件特にオススメ）（20%）"
    ],
    "before": [
      "物件の共有（37%）",
      "費用（29%）",
      "お礼・了承（22%）"
    ],
    "exemplars": [
      "【物件名】\n\n初期費用さらに\n🌟36,000円割引させて頂き\n初期費用：159,830円\n\nスモラなら一般的な不動産業者より96,270円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
      "【物件名】\n\n初期費用さらに\n🌟44,000円割引させて頂き\n初期費用：150,980円\n\nスモラなら一般的な不動産業者より103,720円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。",
      "【物件名】\n\n初期費用さらに\n🌟82,000円割引させて頂き\n初期費用：179,480円\n\nスモラなら一般的な不動産業者より227,520円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。"
    ],
    "counts": {
      "owner": 190,
      "all": 315,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "viewing_invite": {
    "key": "viewing_invite",
    "purpose": "送る情報: スタッフの空いている日時（内覧の候補日）・退去予定の部屋の内覧開始日／使う時: 内覧の希望（日時なし・今見られる部屋）に候補日を出す",
    "writeContains": [
      "内覧の日時（100%）"
    ],
    "structure": {
      "uke": 60,
      "amount": 0,
      "promise": 65,
      "appeal": 25,
      "close": 0
    },
    "nextStep": [
      "AIX 待ち合わせ（58%）"
    ],
    "before": [
      "内覧（56%）"
    ],
    "exemplars": [
      "かしこまりました😊！！\n\n25日が予定埋まっておりまして\n28日以降にスプランディッド難波SOUTH 406号室お部屋ご案内させて頂きます！！\n\n直近ですと\n10/28(水) 15:00〜18:00\n10/29(木) 12:00〜14:00\n10/30(金) 13:00〜15:00にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか！！",
      "YUMAさんお世話になっております！！\nかしこまりました！！\n\nグランパシフィック桜川南902号室、お部屋ご案内させて頂きます😊！！\n\n直近ですと\n本日 10/19(月) 16:00〜18:30\n明日 10/20(火) 15:30〜17:30\n10/21(水) 12:00〜15:00にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！\n\nお部屋他にもオススメできるお部屋、引き続き新着でピックアップ出来次第お送りさせて頂きます！！",
      "かしこまりました！！\nレジェンドール心斎橋EAST 906号室ご案内させて頂きます😊！！\n\n直近ですと\n10/16(金) 12:00〜15:00\n10/17(土) 16:00〜18:30にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！"
    ],
    "counts": {
      "owner": 52,
      "all": 156,
      "misPressStaff": 3,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "application_push": {
    "key": "application_push",
    "purpose": "送る情報: 申込の手続き（申込書の様式・必要書類の案内）／使う時: まだ決めていないお客様の申込の後押し（退去予定の先押さえ・部屋を抑えて内覧）",
    "writeContains": [
      "申込（100%）",
      "申込フォーマット（65%）",
      "駐車場（65%）",
      "ペット（65%）"
    ],
    "structure": {
      "uke": 8,
      "amount": 0,
      "promise": 35,
      "appeal": 0,
      "close": 19
    },
    "nextStep": [],
    "before": [
      "申込・審査（38%）",
      "お礼・了承（35%）"
    ],
    "exemplars": [
      "YUMAさんお世話になっております！！\n\n現在お申込み完了してない状態となります！！\n\nお送り頂き次第、お部屋お申込みしお部屋抑えさせて頂きます！！\nご不明点ございましたらいつでもお気軽にご連絡ください！！",
      "YUMAさんお世話になっております！！\n\n現在まだお申込完了していない状況となります！！\nご不明点等ございましたら、いつでもお気軽にご連絡ください😊！！\nお気に召されましたらお申込みさせて頂き、お部屋抑えさせて頂きますので何卒よろしくお願い致します！！",
      "かしこまりました！！\n10月末のご入居でご希望でお申込み手続き進めさせて頂きます！！\n無事1番手でお申込完了しているか確認出来次第ご連絡させて頂きます！！\n何卒よろしくお願い致します！！"
    ],
    "counts": {
      "owner": 26,
      "all": 95,
      "misPressStaff": 0,
      "misPressOwner": 1
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "followup_revive": {
    "key": "followup_revive",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 申込の書類・情報が届かないまま止まった",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 4,
      "misPressStaff": 0,
      "misPressOwner": 3
    },
    "needsOwnerGold": true,
    "kb": []
  },
  "acknowledge_check": {
    "key": "acknowledge_check",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 御見積書の後に「更に安くならないか」と聞かれた → 代表に初期費用の更なる割引を確認・交渉する約束（お客様あて）",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 6,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": [
      "a1435722"
    ]
  },
  "condition_hearing": {
    "key": "condition_hearing",
    "purpose": "送る情報: 定型の文・フォーム／使う時: 初回でまだ物件を送っておらず、エリアと家賃の両方がそろっていない",
    "writeContains": [
      "条件ヒアリング（100%）",
      "駐車場（86%）",
      "ペット（86%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 0,
      "promise": 0,
      "appeal": 0,
      "close": 0
    },
    "nextStep": [
      "AIX 物件ピックアップした（52%）"
    ],
    "before": [
      "お礼・了承（24%）"
    ],
    "exemplars": [
      "（YUMAさんご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃（管理費込み）\n③ご希望間取り\n④ご希望築年数\n⑤ご希望エリア・最寄り駅\n⑥駅からの徒歩分数\n⑦初期費用ご予算\n⑧その他こだわり条件（ペット・保証人・駐車場等）\n⑨ご入居人数",
      "（ご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃（管理費込み）\n③ご希望間取り\n④ご希望築年数\n⑤ご希望エリア・最寄り駅\n⑥駅からの徒歩分数\n⑦初期費用ご予算\n⑧その他こだわり条件（ペット・保証人・駐車場等）\n⑨ご入居人数",
      "（YUMAさんご希望のお部屋探しご条件）\n①【物件名】⇒\n②【物件名】⇒\n③【物件名】⇒\n④【物件名】⇒\n⑤【物件名】⇒\n⑥【物件名】⇒\n⑦【物件名】⇒\n⑧【物件名】⇒"
    ],
    "counts": {
      "owner": 21,
      "all": 54,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "cost_explain": {
    "key": "cost_explain",
    "purpose": "送る情報: 貸主からの報酬（AD）と還元額／使う時: 費用の安さを不審に思われた・安い理由を聞かれた",
    "writeContains": [
      "金額（100%）",
      "安さの理由（100%）"
    ],
    "structure": {
      "uke": 0,
      "amount": 100,
      "promise": 100,
      "appeal": 67,
      "close": 33
    },
    "nextStep": [
      "AIX 物件ピックアップした（67%）",
      "返事なし（2日）（33%）"
    ],
    "before": [
      "お礼・了承（33%）",
      "物件の質問（33%）",
      "物件の共有（33%）"
    ],
    "exemplars": [
      "YUMAさんお世話になっております！！\n弊社代表から許可頂き125,000円をキャッシュバックさせて頂きます😊！！\n\nこちらのエスリードレジデンス ザ・グラン新大阪フラッツは、貸主様から家賃2ヶ月分の手数料192,727円（税抜）を頂けるお部屋となり、そのうち125,000円をYUMAさんの初期費用に還元し125,000円をキャッシュバックさせて頂く形となります！！",
      "初期費用を抑えられる仕組みについてご説明させて頂きますね😊！！\n\nお部屋によっては貸主様から手数料（家賃1〜2ヶ月分）を頂いており、YUMAさんの初期費用に還元させて頂くことで、費用を抑えられる形となっております！！\n\n仲介手数料は一律2,980円のみとさせて頂いておりますので、最大限費用を抑えさせて頂く形となります！！\n\nこちらの物件は貸主から家賃1ヶ月分の手数料を弊社不動産仲介会社は頂く事が出来ます！！\n35,000円を貸主から頂き、そこから12,000円をYUMAさんさんの初期費用に還元させて頂きます😌！…",
      "はい😊！！\n\n初期費用を抑えられる点についてですが\nお部屋によっては貸主様から手数料（家賃1〜2ヶ月分）を頂いており、YUMAさんの初期費用に還元させて頂くことで費用を抑えられる形となっております！！\n\n仲介手数料2,980円のみとさせて頂いておりますので、最大限費用を抑えさせて頂く形となります！！\n無事ご満足頂くお部屋が見つかるまでサポートさせて頂きます！！\n何卒よろしくお願い致します😌！"
    ],
    "counts": {
      "owner": 3,
      "all": 3,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": false,
    "kb": []
  },
  "greeting_viewing": {
    "key": "greeting_viewing",
    "purpose": "送る情報: 内覧の日時／使う時: 内覧の前（当日の朝・前日）の挨拶",
    "writeContains": [],
    "structure": null,
    "nextStep": [],
    "before": [],
    "exemplars": [],
    "counts": {
      "owner": 1,
      "all": 25,
      "misPressStaff": 0,
      "misPressOwner": 0
    },
    "needsOwnerGold": true,
    "kb": []
  }
};
