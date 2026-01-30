const db = require('../db/schema');

const AnalyticsService = {
    // Получить среднюю позицию для каждого оффера
    getAveragePositions: () => {
        return db.prepare(`
            SELECT company_name, AVG(position) as avg_pos, COUNT(*) as appearances
            FROM offer_stats
            WHERE placement_type = 'main'
            GROUP BY company_name
            ORDER BY avg_pos ASC
        `).all();
    },

    // Данные для графика (история позиций конкретных офферов)
    getOfferHistory: (companyNames) => {
        const placeholders = companyNames.map(() => '?').join(',');
        return db.prepare(`
            SELECT company_name, position, captured_at
            FROM offer_stats
            WHERE company_name IN (${placeholders})
            AND placement_type = 'main'
            ORDER BY captured_at ASC
        `).all(companyNames);
    },

    // Последние результаты по витрине
    getLatestShowcaseResults: (showcaseId) => {
        const run = db.prepare(`
            SELECT id, run_date, screenshot_path 
            FROM parsing_runs 
            WHERE showcase_id = ? AND status = 'success'
            ORDER BY run_date DESC LIMIT 1
        `).get(showcaseId);

        if (!run) return null;

        const offers = db.prepare(`
            SELECT * FROM offer_stats WHERE run_id = ? ORDER BY placement_type, position
        `).all(run.id);

        return { run, offers };
    }
};

module.exports = AnalyticsService;
