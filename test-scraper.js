const { parseShowcase } = require('./src/scraper/index');
const db = require('./src/db/schema');

async function runTest() {
    const sites = db.prepare('SELECT id, url FROM showcases').all();
    for (const site of sites) {
        console.log(`Тестирую парсинг для: ${site.url}`);
        await parseShowcase(site.id);
    }
}

runTest().then(() => {
    console.log('Тестовый запуск завершен');
    process.exit();
}).catch(err => {
    console.error('Критическая ошибка:', err);
    process.exit(1);
});
