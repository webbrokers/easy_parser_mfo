const SecondStageStrategy = require('./src/scraper/strategies/second_stage');

const mockItems = [
    { company_name: "Unknown", link: "https://www.zaymer.ru/kabinet", is_recognized: false },
    { company_name: "Offer", link: "https://turbozaim.ru/?utm=123", is_recognized: false },
    { company_name: "GoodBrand", link: "https://dengi.ru", is_recognized: true },
    { company_name: "МКК «СрочноДеньги»", link: "https://srochnodengi.ru", is_recognized: false },
    { company_name: "   joy money  ", link: "https://joy.money", is_recognized: false } // Проверка очистки и домена
];

console.log("--- BEFORE ---");
mockItems.forEach(i => console.log(`${i.company_name} | ${i.link}`));

const result = SecondStageStrategy.process(mockItems);

console.log("\n--- AFTER ---");
result.forEach(i => console.log(`${i.company_name} | ${i.link}`));

// Простая валидация
const zaymer = result.find(i => i.link.includes('zaymer'));
if (zaymer.company_name === 'Займер') console.log('\n[PASS] Займер определен корректно');
else console.error('\n[FAIL] Займер НЕ определен');

const turbo = result.find(i => i.link.includes('turbozaim'));
if (turbo.company_name === 'Турбозайм') console.log('[PASS] Турбозайм определен корректно');
else console.error('[FAIL] Турбозайм НЕ определен');

const srochno = result.find(i => i.link.includes('srochnodengi'));
if (srochno.company_name === 'СрочноДеньги') console.log('[PASS] СрочноДеньги очищен корректно');
else console.error(`[FAIL] СрочноДеньги некорректен: ${srochno.company_name}`);
