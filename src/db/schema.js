const Database = require('better-sqlite3');
const path = require('path');

const isVercel = process.env.VERCEL === '1';
const dbPath = isVercel 
    ? '/tmp/database.sqlite' 
    : path.join(__dirname, '../../database.sqlite');

let db;
try {
    db = new Database(dbPath);
} catch (err) {
    console.error('Failed to connect to database:', err);
}

if (!db) {
    console.error('Critical: Database object is not initialized. Exiting setup...');
    return; // Прекращаем выполнение файла, если БД не создалась
}

// Таблица витрин (сайтов)
db.prepare(`
    CREATE TABLE IF NOT EXISTS showcases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        custom_selector TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

// Миграция: добавляем custom_selector, если его нет (для старых БД)
try {
    db.prepare("ALTER TABLE showcases ADD COLUMN custom_selector TEXT").run();
} catch (e) {
    // Колонка уже существует, игнорируем ошибку
}

// Миграция: добавляем parser_version, если его нет
try {
    db.prepare("ALTER TABLE showcases ADD COLUMN parser_version TEXT DEFAULT 'v5.6'").run();
} catch (e) {
    // Колонка уже существует, игнорируем ошибку
}

// Лог запусков парсинга
db.prepare(`
    CREATE TABLE IF NOT EXISTS parsing_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        showcase_id INTEGER NOT NULL,
        run_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL,
        screenshot_path TEXT,
        error_message TEXT,
        FOREIGN KEY (showcase_id) REFERENCES showcases(id)
    )
`).run();

// Миграция: добавляем parsing_method, если его нет (для старых БД)
// ВАЖНО: выполняется ПОСЛЕ создания таблицы
try {
    db.prepare("ALTER TABLE parsing_runs ADD COLUMN parsing_method TEXT").run();
    console.log('[DB] Миграция: колонка parsing_method добавлена в parsing_runs');
} catch (e) {
    // Колонка уже существует, игнорируем ошибку
    if (!e.message.includes('duplicate column')) {
        console.warn('[DB] Предупреждение при миграции parsing_method:', e.message);
    }
}

// Миграция: добавляем is_test, если его нет
try {
    db.prepare("ALTER TABLE parsing_runs ADD COLUMN is_test INTEGER DEFAULT 0").run();
    console.log('[DB] Миграция: колонка is_test добавлена в parsing_runs');
} catch (e) {
    if (!e.message.includes('duplicate column')) {
        console.warn('[DB] Предупреждение при миграции is_test:', e.message);
    }
}

// Статистика офферов
db.prepare(`
    CREATE TABLE IF NOT EXISTS offer_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        placement_type TEXT DEFAULT 'main', -- main, b1, b2, b3
        position INTEGER NOT NULL,
        company_name TEXT NOT NULL,
        link TEXT NOT NULL,
        image_url TEXT,
        captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES parsing_runs(id)
    )
`).run();

// Таблица для сбора нераспознанных брендов (v3.0)
db.prepare(`
    CREATE TABLE IF NOT EXISTS unknown_brands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        showcase_id INTEGER NOT NULL,
        run_id INTEGER NOT NULL,
        raw_name TEXT,
        link TEXT,
        position INTEGER,
        captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (showcase_id) REFERENCES showcases(id),
        FOREIGN KEY (run_id) REFERENCES parsing_runs(id)
    )
`).run();

// Миграция: добавляем debug_json для v1.7.0
try {
    db.prepare("ALTER TABLE unknown_brands ADD COLUMN debug_json TEXT").run();
    console.log('[DB] Миграция: колонка debug_json добавлена в unknown_brands');
} catch (e) {
    if (!e.message.includes('duplicate column')) {
        console.warn('[DB] Предупреждение при миграции debug_json:', e.message);
    }
}

// Таблица для хранения эталонных логотипов брендов (v2.9)
db.prepare(`
    CREATE TABLE IF NOT EXISTS persistent_logos (
        brand_name TEXT PRIMARY KEY,
        logo_url TEXT NOT NULL,
        source_domain TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

// Наполнение начальными данными, если пусто
const count = db.prepare('SELECT count(*) as count FROM showcases').get().count;
if (count === 0) {
    const initialSites = [
        { url: 'https://robot-zaymer.ru/', name: 'Robot Zaymer' },
        { url: 'https://zyamer.ru/', name: 'Zyamer Главная' },
        { url: 'https://zyamer.ru/smart/', name: 'Zyamer Smart' },
        { url: 'https://odobrenzaym.ru/', name: 'Odobren Zaym' },
        { url: 'https://www.sravni.ru/zaimy/', name: 'Sravni.ru Zaimy' },
        { url: 'https://brobank.ru/zajmy/', name: 'Brobank.ru Zajmy' },
        { url: 'https://zaimis-ka.online/', name: 'Zaimis-ka' },
        { url: 'https://rating-zaimov.ru/zaimy-bez-otkaza', name: 'Rating Zaimov' },
        { url: 'https://denga.info/', name: 'Denga Info' }
    ];
    
    const insert = db.prepare('INSERT INTO showcases (url, name) VALUES (?, ?)');
    initialSites.forEach(site => insert.run(site.url, site.name));
    console.log('Database seeded with initial showcases.');
}

module.exports = db;
