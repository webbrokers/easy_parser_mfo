const { parseShowcase } = require('./scraper/index');
const db = require('./db/schema');
const { sendTelegramMessage } = require('./services/telegram');

async function dailyTask() {
    console.log('[Scheduler] Starting daily parsing...');
    const sites = db.prepare('SELECT id, name FROM showcases WHERE is_active = 1').all();
    
    let report = `<b>📊 Ежедневный отчет парсинга</b>\nДата: ${new Date().toLocaleDateString()}\n\n`;
    
    const { asyncPool } = require('./utils/async-pool');
    const concurrency = parseInt(process.env.MAX_CONCURRENCY) || 1;
    
    await asyncPool(concurrency, sites, async (site) => {
        console.log(`[Scheduler] Parsing ${site.name}...`);
        const result = await parseShowcase(site.id);
        
        if (result.success) {
            report += `✅ ${site.name}: Найдено ${result.count} офферов\n`;
        } else {
            report += `❌ ${site.name}: Ошибка (${result.error})\n`;
        }
    });
    
    await sendTelegramMessage(report);
    console.log('[Scheduler] Daily task finished.');
}

// Запуск раз в сутки (в 03:00 ночи)
const cron = require('node-cron');
// Если cron не установлен, установим его позже. Пока просто экспортируем функцию.

module.exports = { dailyTask };
