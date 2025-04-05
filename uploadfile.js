const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// アップロードするローカルディレクトリのパス
const localDir = './assets'; // アップロードしたいディレクトリのパスを指定

// R2バケット名とターゲットディレクトリ（R2バケット内の保存場所）
const bucketName = ''; // R2のバケット名
const targetDir = 'assets'; // R2バケット内での保存先ディレクトリ

// 指定したディレクトリ内のすべてのファイルを取得
fs.readdir(localDir, (err, files) => {
  if (err) {
    console.error('Error reading directory:', err);
    return;
  }

  // ディレクトリ内の各ファイルをR2にアップロード
  files.forEach((file) => {
    const filePath = path.join(localDir, file);
    const remoteKey = path.join(targetDir, file); // R2内でのファイルのパス

    // `wrangler r2 object put` コマンドを実行してファイルをアップロード
    exec(`wrangler r2 object put --file=${filePath} ${bucketName}/${remoteKey}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error uploading file ${file}:`, error);
        return;
      }
      if (stderr) {
        console.error(`stderr for ${file}:`, stderr);
        return;
      }
      console.log(`Successfully uploaded ${file} to ${remoteKey}`);
    });
  });
});
