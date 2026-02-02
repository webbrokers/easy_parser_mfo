const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.all("SELECT id, name, url, custom_selector FROM showcases WHERE url LIKE '%robot-zaymer.ru%';", [], (err, rows) => {
  if (err) {
    console.error(err);
    return;
  }
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
