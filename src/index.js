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

// Настройка EJS и статики
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Маршруты
app.get('/', async (req, res) => {
    try {
        const showcases = db.prepare('SELECT * FROM showcases').all();
        const avgPos = AnalyticsService.getAveragePositions();
        
        const stats = {
            totalShowcases: showcases.length,
            totalOffers: db.prepare('SELECT count(*) as count FROM offer_stats').get().count,
            runsToday: db.prepare("SELECT count(*) as count FROM parsing_runs WHERE date(run_date) = date('now')").get().count,
            errorsToday: db.prepare("SELECT count(*) as count FROM parsing_runs WHERE date(run_date) = date('now') AND status = 'error'").get().count
        };

        res.render('index', { 
            title: 'Дашборд', 
            showcases, 
            avgPos, 
            stats 
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

// Планировщик ежедневного парсинга (03:00)
cron.schedule('0 3 * * *', () => {
    dailyTask();
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

// Запуск сервера
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Сервер запущен на http://localhost:${PORT}`);
    });
}

module.exports = app;
