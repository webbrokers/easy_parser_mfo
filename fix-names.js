const db = require('./src/db/schema');
const { parseShowcase } = require('./src/scraper/index');

async function fixNames() {
    console.log('Попытка улучшенного парсинга для уточнения имен...');
    const result = await parseShowcase(1); // Robot Zaymer
    console.log('Результат:', result);
}

fixNames();
