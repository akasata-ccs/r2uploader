# Serverless Image Uploader

Cloudflare **Workers + R2** を利用した、サーバーレス画像アップローダーAPIです。

画像のアップロード・一覧取得・削除・サムネイル生成をシンプルなAPIとして提供します。

フロントエンドは含まれていません。
自作するか、デモサイトを参考にしてください。

デモ：https://upload.takayama345.net

---

# 特徴

* Cloudflare Workersのみで動作
* R2へ画像を保存
* サムネイル生成対応
* グループ単位で画像を管理
* 有効期限付き画像
* 期限切れ画像を自動削除
* シークレットキーによるアップロード制限

---

# 動作環境

* Node.js
* npm
* Cloudflareアカウント
* Wrangler CLI

---

# セットアップ

## 1. Wranglerをインストール

```bash
npm install -g wrangler
```

---

## 2. Cloudflareへログイン

```bash
wrangler login
```

ブラウザが開くのでCloudflareへログインします。

---

## 3. プロジェクトを作成

```bash
npm create cloudflare@latest
```

テンプレートとしてこのリポジトリを指定してください。

作成後、プロジェクトディレクトリへ移動します。

---

## 4. R2バケットを作成

```bash
npx wrangler r2 bucket create image-bucket
```

実行後に表示される内容の `r2_buckets` を `wrangler.jsonc` に追加します。

---

## 5. シークレットキーを設定

```bash
npx wrangler secret put AUTH_KEY_SECRET
```

表示されたらアップロード時に使用する認証キーを入力します。

```
? Enter a secret value:
```

---

## 6. デプロイ

```bash
npm run deploy
```

Worker・R2の設定を反映してデプロイします。

---

# API

## PUT `/upload`

画像をアップロードします。

1リクエストにつき1ファイルのみアップロードできます。

### リクエストヘッダー

| Header                |  必須 | 説明                                              |
| --------------------- | :-: | ----------------------------------------------- |
| `X-Custom-Auth-Key`   |  ✔  | 認証キー                                            |
| `X-Custom-Orig-Name`  |  ✔  | 元ファイル名。空文字や空白だけの値は指定できません。                  |
| `X-Custom-Group-Name` |     | グループ名。省略すると自動生成されます。以降のアップロードでは返却された値を指定してください。 |

### レスポンス例

```json
{
  "status": "OK",
  "message": "Put successfully!",
  "fileName": "hkz9t3ykn4/7f2a7d38-1c85-477d-aab5-54c7528abcde",
  "origName": "sample.jpg",
  "groupName": "hkz9t3ykn4",
  "length": 10884814
}
```

### PowerShellサンプル

```powershell
Invoke-RestMethod `
  -Method PUT `
  -InFile "C:\sample.jpg" `
  -Headers @{
    "X-Custom-Auth-Key"   = "YOUR_SECRET"
    "X-Custom-Orig-Name"  = "sample.jpg"
    "X-Custom-Group-Name" = "group-name"
  } `
  -Uri "https://example.com/upload"
```

---
## PATCH `/upload`

ZIP保存時のファイル名を指定します。

### リクエストヘッダー

| Header              | 必須 | 説明     |
| ------------------- | :-: | -------- |
| `X-Custom-Auth-Key` |  ✔  | 認証キー |

### JSONボディ

| Field        | 必須 | 説明                         |
| ------------ | :-: | ---------------------------- |
| `groupName`  |  ✔  | 更新するグループ名           |
| `groupTitle` |  ✔  | ZIPファイル名（日本語使用可） |

```json
{
  "groupName": "hkz9t3ykn4",
  "groupTitle": "旅行写真"
}
```

### レスポンス例

```json
{
  "status": "OK",
  "message": "Patch successfully!"
}
```

### PowerShellサンプル

```powershell
Invoke-RestMethod `
  -Method PATCH `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{
    groupName = "hkz9t3ykn4"
    groupTitle = "旅行写真"
  } | ConvertTo-Json -Compress) `
  -Headers @{
    "X-Custom-Auth-Key" = "YOUR_SECRET"
  } `
  -Uri "https://example.com/upload"
```

---

## DELETE `/upload`

アップロード済み画像を削除します。

### リクエストヘッダー

| Header                |  必須 | 説明                              |
| --------------------- | :-: | ------------------------------- |
| `X-Custom-Auth-Key`   |  ✔  | 認証キー                            |
| `X-Custom-Group-Name` |  ✔  | グループ名                           |
| `X-Custom-Orig-Name`  |     | 削除する元ファイル名。省略するとグループ内すべてを削除します。 |

---

## GET `/api/<groupName>`

指定したグループに存在する画像一覧を取得します。画像はR2の `groups/<groupName>/` プレフィックスから取得します。

アップロードから60日以上経過した画像は一覧から除外され、取得時にR2から削除されます。定期処理でも期限切れ画像を削除します。
一覧は最大1000件です。さらに画像がある場合、`truncated` が `true` になります。

### レスポンス例

```json
{
  "group_title": "archive",
  "group_name": "hkz9t3ykn4",
  "images": [
    {
      "file_name": "hkz9t3ykn4/7f2a7d38-1c85-477d-aab5-54c7528abcde",
      "orig_name": "DSCF9293.JPG",
      "length": 10884814
    }
  ],
  "truncated": false
}
```

---

## GET `/image/<groupName>/<fileId>`

画像をそのまま返します。

ブラウザから通常の画像URLと同じように利用できます。

例

```
https://example.com/image/hkz9t3ykn4/7f2a7d38-1c85-477d-aab5-54c7528abcde
```

---

## GET `/thumb/<groupName>/<fileId>`

サムネイル画像を返します。

一覧表示やギャラリー表示などに利用できます。

`注：サムネイル機能はカスタムドメインを設定することで有効になります。`

---

# ディレクトリ構成

```
.
├── assets/             # 静的ファイル
├── src/
├── wrangler.jsonc
└── README.md
```

`wrangler.jsonc` の `assets` 設定では `assets` ディレクトリを静的ファイルとして配信します。

---

# 制限事項

Cloudflare Freeプランでは以下の制限があります。

* アップロードは1リクエストあたり最大100MB
* R2ストレージ容量にはプランごとの上限があります

最新の制限はCloudflare公式ドキュメントを参照してください。

---

# 更新履歴

## 2026-11-02

* D1使用を廃止
* グループごとにプレフィックスパスに格納するよう変更

## 2026-06-21

* 静的ファイルのR2配置を廃止
* Workerから静的ファイルを配信する構成へ変更

---

# ライセンス

MIT License

Copyright (c) 2026 akasata_ccs

Permission is hereby granted, free of charge, to any person obtaining a copy
...
