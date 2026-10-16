# 指差し（yubisashi）

Claude Code の Mod です。ブラウザで画面の部品を選んで一言書くと、その部品の住所（セレクタ）・見た目の値・直すファイルの候補をつけて、Claude に UI の直しを頼めます。大きさ・間隔・位置・色は、ブラウザで見ながら決めた値をそのまま送れます。

## 要る物

- Mac（Linux でもおそらく動きます。Windows では動きません）
- Node.js 18.13 以上（`node --version` で確かめる。無ければ https://nodejs.org から入れる）
- 新しい Claude Code（2.1.301 で確かめました。古いときは `claude update`）
- 会社が管理している Claude Code では、一部が動きません

## 入れ方

ターミナルの Claude Code の入力欄で、次の1行を打ちます。

```
/plugin install yubisashi --marketplace yuuya-miyagaki/yubisashi
```

1. `Add marketplace?` と聞かれたら `y`
2. 入れる範囲を選ぶ画面で、いちばん上（user）のまま Enter
3. `Installed yubisashi.` と出たら、そのまま使えます

シェルから入れるとき:

```
claude plugin install yubisashi --marketplace yuuya-miyagaki/yubisashi
```

デスクトップアプリ（`/plugin` が使えない所）では、入力欄の横の + → Plugins → Add marketplace に `yuuya-miyagaki/yubisashi` を入れ → Add plugin。

## 使い方

| 打つ物 | すること |
| --- | --- |
| `/yubi` | 前回のページ・最近直した HTML・動いている開発サーバーから選んで開く（動いているときは、いまの状態と「開く・止める」） |
| `/yubi 3000` | `localhost:3000` の開発サーバーを開く |
| `/yubi ./site` | フォルダ（の `index.html`）や HTML ファイルを開く。ファイルをターミナルへドラッグしてもよい |
| `/yubi 止める` | 止める |

ブラウザでは:

- 右下の丸か、Alt（Mac は Option）＋クリックで部品を選ぶ。Alt を押したままにすると枠と名札が出る。↑↓ で重なった部品を選び直す
- 一言書いて「送る」（すぐ Claude に頼む）か「下書きへ」（Claude Code の入力欄に足す）
- 部品を選んで「大きさ」「間隔・位置」「色」を押すと、つまみや数字・このページの色で決めて送れる（「同じ作りの部品すべて」にも当てられる）
- Claude が【確認】で聞いてきたら、ブラウザの選択肢で返事をする
- 直し終わると、ページは自動で読み直されます

## 新しい版にする

```
claude plugin marketplace update yubisashi
claude plugin update yubisashi@yubisashi
```

その後、Claude Code を開き直します。動いている指差しは `/yubi 止める` → `/yubi` で起こし直します。

## 外す

```
claude plugin uninstall yubisashi@yubisashi
```

## 仕組みと安全

- 手元に小さな中継役（Node.js）を `127.0.0.1` の 4000〜4099 番で立て、開いたページに部品を選ぶ仕掛けを差し込みます。ページのファイルは書き換えません
- 中継役は起動のたびに作る合言葉を持ち、外への通信はしません
- 直しは Claude Code がいつもどおり行います（ファイルの書き換えは、ふだんの許可の設定に従います）
