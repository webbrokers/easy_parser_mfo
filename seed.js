const db = require('./src/db/schema');

const sites = [
    { name: 'Robot Zaymer', url: 'https://robot-zaymer.ru/' },
    { name: 'Zyamer', url: 'https://zyamer.ru/' },
    { name: 'Zyamer Smart', url: 'https://zyamer.ru/smart/' },
    { name: 'Zaymer Cabinet', url: 'https://zaymer-cabinet.ru/' }
];

const insert = db.prepare('INSERT OR IGNORE INTO showcases (name, url) VALUES (?, ?)');

sites.forEach(site => {
    insert.run(site.name, site.url);
    console.log(`Добавлен сайт: ${site.name} (${site.url})`);
});

console.log('Начальные данные вставлены.');
process.exit();
