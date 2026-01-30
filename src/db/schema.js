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

// Таблица витрин (сайтов)
db.prepare(`
    CREATE TABLE IF NOT EXISTS showcases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

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

module.exports = db;
