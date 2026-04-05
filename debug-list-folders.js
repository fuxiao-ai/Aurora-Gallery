const path = require('path');
const PhotoDatabase = require('./src/database');

/**
 * 列出数据库中所有含人脸的文件夹
 */

async function main() {
  var userDataPath = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  // 与 Electron userData 一致：开发时包名为 aurora-gallery（见 package.json name）
  var dbPath = path.join(userDataPath, 'aurora-gallery', 'photos.db');
  console.log('Using database:', dbPath);
  var db = new PhotoDatabase(dbPath);
  db.ensureFaceSchemaLazy();

  console.log('Listing folders with faces...\n');

  var stmt = db.db.prepare(`
    SELECT DISTINCT p.folder_path
    FROM faces f
    LEFT JOIN photos p ON p.id = f.photo_id
    WHERE p.folder_path IS NOT NULL
    ORDER BY p.folder_path
  `);
  var rows = stmt.all();

  console.log('Total folders with faces: ' + rows.length + '\n');

  // 查找包含目标关键字的文件夹
  var keyword = '精选';
  for (var i = 0; i < rows.length; i++) {
    var fp = rows[i].folder_path;
    if (fp.toLowerCase().includes(keyword.toLowerCase())) {
      console.log('  ' + fp);
    }
  }

  console.log('\nComplete. Look above for your folder path.');
  db.close();
}

main().catch(function (err) {
  console.error('ERROR:', err);
  process.exit(1);
});
