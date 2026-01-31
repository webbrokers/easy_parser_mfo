require('dotenv').config();
const express = require('express');
const path = require('path');
const AnalyticsService = require('./services/analytics');
const { parseShowcase } = require('./scraper/index');
const db = require('./db/schema');

const cron = require('node-cron');
const { dailyTask } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Принудительно слушаем на всех интерфейсах для облака
const HOST = '0.0.0.0';

// Настройка EJS и статики
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Маршруты
app.get('/', async (req, res) => {
    try {
        const showcases = db.prepare(`
            SELECT 
                s.*,
                (SELECT COUNT(*) FROM offer_stats WHERE run_id = (
                    SELECT id FROM parsing_runs WHERE showcase_id = s.id AND status = 'success' ORDER BY run_date DESC LIMIT 1
                )) as last_offers_count,
                CAST((julianday('now') - julianday(s.created_at)) AS INTEGER) as days_active
            FROM showcases s
            ORDER BY s.id DESC
        `).all();
        const avgPos = AnalyticsService.getAveragePositions();
        
        const stats = {
            totalShowcases: showcases.length,
            totalOffers: db.prepare('SELECT count(*) as count FROM offer_stats').get().count,
            runsToday: db.prepare("SELECT count(*) as count FROM parsing_runs WHERE date(run_date) = date('now')").get().count,
            errorsToday: db.prepare("SELECT count(*) as count FROM parsing_runs WHERE date(run_date) = date('now') AND status = 'error'").get().count
        };

        const globalHistory = AnalyticsService.getGlobalHistory();

        res.render('index', { 
            title: 'Дашборд', 
            showcases, 
            avgPos, 
            stats,
            globalHistory 
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/showcase/:id', async (req, res) => {
    try {
        const showcase = db.prepare('SELECT * FROM showcases WHERE id = ?').get(req.params.id);
        if (!showcase) return res.status(404).send('Not Found');
        const latest = AnalyticsService.getLatestShowcaseResults(req.params.id);
        res.render('showcase', { title: showcase.name, showcase, latest });
    } catch (e) {
        console.error(e);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/offers', async (req, res) => {
    try {
        const offers = AnalyticsService.getAveragePositions();
        res.render('offers', { title: 'Все офферы', offers });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
});

app.get('/logs', async (req, res) => {
    try {
        const errors = AnalyticsService.getErrorLogs();
        res.render('logs', { title: 'Логи ошибок', errors });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
});

app.get('/settings', async (req, res) => {
    try {
        const showcases = db.prepare('SELECT * FROM showcases').all();
        res.render('settings', { title: 'Настройки', showcases });
    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
});

// Планировщик ежедневного парсинга (03:00)
cron.schedule('0 3 * * *', () => {
    dailyTask();
});

// API для получения списка активных витрин
app.get('/api/showcases/active', (req, res) => {
    const sites = db.prepare('SELECT id, name FROM showcases WHERE is_active = 1').all();
    res.json(sites);
});

// API для запуска парсинга одной витрины
app.post('/api/run-showcase/:id', async (req, res) => {
    try {
        const result = await parseShowcase(req.params.id);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API для переключения статуса витрины
app.post('/api/showcase/:id/toggle', (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        db.prepare('UPDATE showcases SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// API для запуска парсинга
app.post('/api/run-all', async (req, res) => {
    const sites = db.prepare('SELECT id FROM showcases WHERE is_active = 1').all();
    const results = [];
    
    // Запускаем последовательно, чтобы не положить систему
    for (const site of sites) {
        const result = await parseShowcase(site.id);
        results.push({ id: site.id, ...result });
    }
    
    res.json({ success: true, results });
});

// Добавление новой витрины
app.post('/api/showcases', express.urlencoded({ extended: true }), (req, res) => {
    const { name, url } = req.body;
    try {
        db.prepare('INSERT INTO showcases (name, url) VALUES (?, ?)').run(name, url);
        res.redirect('/settings');
    } catch (e) {
        res.status(500).send('Ошибка при добавлении: ' + e.message);
    }
});

// Удаление витрины
app.post('/api/showcases/delete/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM showcases WHERE id = ?').run(req.params.id);
        res.redirect('/settings');
    } catch (e) {
        res.status(500).send('Ошибка при удалении');
    }
});

// Запуск сервера
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Сервер запущен на порту ${PORT} (0.0.0.0)`);
    });
}

module.exports = app;
