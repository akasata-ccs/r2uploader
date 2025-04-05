# これは何？
CloudflareさんのWorker、D1、R2サービスを活用したサーバレス画像アップローダーAPI。  
ガワは自作するか[パクって](https://upload.takayama345.net)ください。

# ハウツー
前提：npmが使えること

### モジュール取得
```
npm install
```


### Cloudflareにログイン
```
wrangler login
```
ブラウザが開くのでログインする

### D1データベースを作成
```
npx wrangler d1 create test  
```
レスポンスの情報をwrangler.jsonc ファイルの `d1_databases` に設定する。


### R2バケットを作成
```
npx wrangler r2 bucket create <BacketName>
```

レスポンスの情報をwrangler.jsonc ファイルの `r2_buckets` に設定する。

### アップロード用のシークレットキーを設定する
```
npx wrangler secret put AUTH_KEY_SECRET
```
`? Enter a secret value: »` `<設定する値>`


## エンドポイント
### `/upload (PUT)`
アップロード用のエンドポイントです。
1度に1ファイル送信します。
CloudFlareでプロキシする場合、フリープランでは100MBの制限があるため、アップロードの際にはこれを超えないように注意します。

リクエストヘッダー：

- `X-Custom-Auth-Key (require)`
  - シークレットキーです。設定した値をセットします。
- `X-Custom-Orig-Name (require)`
  - レスポンスで受け取るファイル名です。
- `X-Custom-Group-Name`
  - グループ名です。
  - なしで送信すると、サーバー側で自動的に生成するので、2回目以降ではそれを使って送信します。

レスポンス例：
```
{
    status: 'OK',
    message: `Put <バケット上に配置されたファイル名> successfully!`,
    name: <ファイル名>,
    groupName:　<グループ名>,
    length: <ファイルサイズ>
}
```

リクエストサンプル（PowerShell）：
```
Invoke-Restmethod `
      -InFile <ファイルのパス> `
      -method PUT `
      -header @{
      "X-Custom-Auth-Key"   = <シークレットキー>;
      "X-Custom-Orig-Name"  = <登録したいファイル名>;
      "X-Custom-Group-Name" = <グループ名（初回は無し）>
    } `
      -uri "<ドメイン>/upload";
```

### `/api/<グループ名> (GET)`
指定したグループ名でアップロードされたファイルがあれば、その一覧を返します。
`expire_date` を過ぎると、取得できなくなります。（R2バケットからも削除します）

レスポンス例：
```
[
  {
    "file_name": "1743853084441",
    "orig_name": "DSCF9293.JPG",
    "group_name": "hkz9t3ykn4",
    "expire_date": "1745107199",
    "length": 10884814,
    "parse_expire_date": "2025年04月19日"
  },
  {
    "file_name": "1743853090352",
    "orig_name": "DSCF9294.JPG",
    "group_name": "hkz9t3ykn4",
    "expire_date": "1745107199",
    "length": 14116455,
    "parse_expire_date": "2025年04月19日"
  }
]
```

### `/image/<ファイル名> (GET)`
imageとしてレスポンスします。画像ファイルが置かれているのと同じ感覚。

### `/thumb/<ファイル名> (GET)`
サムネイル用に画像を縮小してレスポンスします。一覧とか作りたいときに。

## 資源の配置
### 手順
1. `assets` ディレクトリを作成し、R2バケットに配置します。  
2. `npm run dest` を実行すると、バケットに資源を転送します。
### tips
- この資源は `/assets/*` で静的資源として読み込みができます。  
- ただし、`favicon.ico` だけは `/favicon.ico` のパスとしてレスポンスします。  
- 公開用にHTMLファイルを置く場合は、 `index.html` を作成します。  
このHTMLファイルは、`/` または `/<グループ名>` でアクセスした時に使用されます。

# 注意点
- フリープランによる制限
  - アップロードリクエストは1回あたり100MBまでです。それ以上はアップロードできません。
  - R2にアップロードできるのは1アカウントあたり10GBっぽいです。