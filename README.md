# セレッジ 請求・支払・収支管理システム

セレッジで使っていた4本のExcel（社内申込書ツール・売上表・売上支払一覧・月末支払い管理）を、1つのWebアプリにまとめる。
担当者が変わっても、経理の専門知識がなくても、請求・支払・収支管理を正確に続けられることが目的。

- 設計書：Claude Docs「セレッジ管理システム 技術レビューと基本設計案」
- 仕様書：ペチ作成「GoGo実装依頼用 統合仕様書 v0.3」

## いまできること

| 機能 | 状態 |
| --- | --- |
| ログイン（招待した人だけ） | できた |
| 企業の登録・変更（宛名・住所・送り方・入金予定） | できた |
| 契約の登録・変更（人数・単価・消費税・◯月分・回数・品名のひな形） | できた |
| 変更履歴（だれが・いつ・何を） | できた |
| データベース全体（請求・売上・請求書・入金・支払い・固定費） | できた（画面はこれから） |
| 今月の請求（契約から下書きを作る・送り方と日付を選ぶ・請求書の見え方・印刷/PDF保存） | お試し版（送付OKはまだ出していない） |
| 送付OK・送付待ち一覧・封筒 | これから |
| 支払い管理・総務への依頼 | これから |
| 入金・収支サマリ | これから |

## 使う人と役割

| 役割 | できること |
| --- | --- |
| 管理者（admin） | すべての入力・変更 |
| 閲覧（viewer） | 見るだけ（社長など） |
| 承認待ち（pending） | 何も見られない。管理者が役割を決めるまでの状態 |

最初に登録した1人が自動で管理者になる。2人目からは承認待ちになるので、管理者が役割を変える。

---

## はじめの準備（1回だけ）

### 1. Supabase のプロジェクトを作る

1. https://supabase.com にログインし、**New project** を押す
2. **Name**：`selege-keiri`
3. **Database Password**：長いパスワードを作り、パスワード管理ツールに保存する（あとで使うことはほぼない）
4. **Region**：**Northeast Asia (Tokyo)**
5. **Create new project** を押し、準備ができるまで1〜2分待つ

### 2. データベースの表を作る

1. 左のメニューの **SQL Editor** を開く
2. **New query** を押す
3. このリポジトリの `supabase/migrations/0001_init.sql` の中身をすべて貼り付ける
4. 右下の **Run** を押す。「Success. No rows returned」と出ればOK

### 2-1. 追加の仕組みを入れる（0002 以降）

`supabase/migrations/` に 0002 以降のファイルが増えたら、番号の順に1回ずつ実行する（何度実行しても同じ結果になる）。

1. **SQL Editor** → **New query** に `supabase/migrations/0002_billing_drafts.sql` の中身をすべて貼り付ける
2. **Run** を押す。「Success. No rows returned」と出ればOK
3. `0003_bills.sql`（請求の入力）も同じように実行する

### 2-2. 旧Excelの企業と契約を取り込む

1. ひろみが確認した「取り込み確認_企業と契約」から作った `seed_import.sql` を用意する（取引先の実データなので GitHub には置かない）
2. **SQL Editor** → **New query** に中身をすべて貼り付けて **Run** を押す
3. 何度実行しても、同じ企業・同じ契約は二重に入らない

作り直すとき：`python3 tools/build_seed.py <確認済み.xlsx> data/private/seed_import.sql --email 社名,社名`（`--email` はいつもの送り方がメールの企業、`--on-demand` は都度請求の契約を持つ企業）

### 2-3. 請求書に印字する自社の情報を入れる

**SQL Editor** で、`issuer` の値（社名・住所・電話・登録番号・振込先）を入れる。実データなので GitHub には置かない。
住所と振込先は `\n` で改行できる。角印は `"seal": "data:image/png;base64,..."` として同じ値に入れる（作り方はゴゴに頼む）。

```sql
update app_settings set value = '{
  "name": "社名",
  "postal_code": "000-0000",
  "address": "住所1行目\nビル名など2行目",
  "phone": "00-0000-0000",
  "registration_no": "T0000000000000",
  "bank": "銀行名 支店名 普通 0000000\n口座名義"
}'::jsonb where key = 'issuer';
```

### 3. 勝手にアカウントを作れないようにする

1. 左のメニューの **Authentication** を開く
2. **Sign In / Providers**（画面によっては **Providers** や **Settings**）を開く
3. **Allow new users to sign up** をオフにして保存する

### 4. 自分のアカウントを作る（最初の1人＝管理者）

1. **Authentication** → **Users** を開く
2. **Add user** → **Create new user** を押す
3. メールアドレスとパスワードを入れ、**Auto Confirm User** にチェックを入れて作成する

### 5. Vercel に設定を入れる

1. Supabase の **Project Settings** → **API**（画面によっては **API Keys** と **Data API**）を開く
2. **Project URL** と **anon public**（または **publishable**）キーをコピーする
3. Vercel でこのリポジトリをインポートし、**Settings** → **Environment Variables** に次の2つを入れる

| 名前 | 値 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public（publishable）キー |

4. **Deployments** から再デプロイする

`service_role`（secret）キーはこのアプリでは使わない。どこにも貼らないこと。

### 社長など、見るだけの人を追加するとき

1. 上の「4.」と同じ手順でアカウントを作る（この人は承認待ちになる）
2. Supabase の **Table Editor** → `profiles` を開く
3. その人の行の `role` を `viewer` に変えて保存する

---

## 開発する人向け

```bash
npm install
cp .env.example .env.local   # 値を入れる
npm run dev                  # http://localhost:3000
npm run test:db              # データベース設計のテスト（PGlite で本物の PostgreSQL を動かす）
npm run lint
npm run build
```

### フォルダ

| 場所 | 中身 |
| --- | --- |
| `docs/decisions.md` | 決まった業務ルールと、まだ決めていないこと |
| `docs/excel-structure.md` | 旧Excel 4本の作り（解析メモ）。原本は不明点が出たときだけ開く |
| `supabase/migrations/` | データベースの設計（SQL） |
| `tests/db.test.mjs` | データベースのルールのテスト |
| `src/app/` | 画面 |
| `src/lib/` | 共通の処理（入力チェック、表示の整形、品名の組み立て） |
| `tools/extract_import.py` | 旧Excelから取り込み候補を取り出す |
| `data/private/` | 取引先の実データ置き場。**Git に入れない** |

### 大事なルール（設計書より）

- 売上台帳（`sales`）が売上の正本。請求書・入金はそこにぶら下げる
- 同じ支出を `payables` と `monthly_costs` の両方に入れない（家賃は `payables`）
- 金額は円の整数。消費税は請求書ごとに1回だけ計算し、端数の扱いは `calc_tax` と設定で決める
- 請求書の流れは「下書き → 送付OK → 送付済み」。社長の承認・「確定」の手順は作らない
  - 下書き：自由に保存・修正できる
  - 送付OK：その時点の内容を固定し、番号（例：`2711-01`）と売上ができる。直すときは送付OKを取り消して、もう一度確認する
  - 送付済み：直すときは同じ番号で訂正版を作る。前の版は「訂正済み（旧版）」として残る
- 請求書を作らない売上は、送付OKを通らずに売上にできる（`request_record_sale`）
- 送り方（郵送／メール）は請求書ごとにその都度選ぶ。企業の「いつもの送り方」は目安
- 契約の請求のしかたは「毎月（分割・月額）」「都度（請求するときだけ）」「1回だけ」。都度の契約は、請求のない月を「未請求」と出さない
- 状態を変える操作は、データベースの関数（`invoice_send_ok` など）を通す。2回押しても1回分にしかならない
- 前月の請求内容を自動で送付OKにしない。ひな形は出すが、送付OKは人が押す
- 業務ルールが決まっていないことは、仮のルールで固めない（設計書の確認事項を参照）
