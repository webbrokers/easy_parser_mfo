const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

const sites = [
    { url: 'https://zaimis-ka.online/', name: 'Zaimis-ka' },
    { url: 'https://rating-zaimov.ru/zaimy-bez-otkaza', name: 'Rating Zaimov' },
    { url: 'https://denga.info/', name: 'Denga Info' }
];

const insert = db.prepare('INSERT OR IGNORE INTO showcases (url, name) VALUES (?, ?)');

sites.forEach(site => {
    const result = insert.run(site.url, site.name);
    if (result.changes > 0) {
        console.log(`Added: ${site.url}`);
    } else {
        console.log(`Skipped (already exists): ${site.url}`);
    }
});

db.close();
