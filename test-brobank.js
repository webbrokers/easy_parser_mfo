const { parseShowcase } = require('./src/scraper/index.js');
const db = require('./src/db/schema.js');

async function test() {
    console.log('--- Начинаю тестирование Brobank.ru ---');
    
    // Находим ID витрины
    const showcase = db.prepare('SELECT id FROM showcases WHERE url LIKE ?').get('%brobank.ru%');
    
    if (!showcase) {
        console.error('Витрина Brobank не найдена в БД!');
        return;
    }
    
    console.log(`ID витрины: ${showcase.id}. Запускаю парсинг...`);
    
    try {
        await parseShowcase(showcase.id);
        
        // Проверяем результаты
        const run = db.prepare('SELECT id FROM parsing_runs WHERE showcase_id = ? ORDER BY run_date DESC LIMIT 1').get(showcase.id);
        if (run) {
            const stats = db.prepare('SELECT count(*) as count FROM offer_stats WHERE run_id = ?').get(run.id);
            console.log(`Парсинг завершен. Собрано офферов: ${stats.count}`);
            
            const samples = db.prepare('SELECT company_name, link FROM offer_stats WHERE run_id = ? LIMIT 10').all(run.id);
            console.log('Примеры собранных данных:');
            console.table(samples);
        }
    } catch (e) {
        console.error('Ошибка в тесте:', e);
    }
}

test();
