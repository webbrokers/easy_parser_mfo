/**
 * Pattern Detector - Модуль для поиска повторяющихся структур на странице
 * Используется для автоматического определения карточек офферов
 */

class PatternDetector {
    /**
     * Находит повторяющийся паттерн карточек офферов на странице
     * @param {number} minCount - Минимальное количество повторений (по умолчанию 5)
     * @param {number} maxCount - Максимальное количество повторений (по умолчанию 50)
     * @returns {string|null} - CSS-селектор найденного паттерна или null
     */
    static findOfferPattern(minCount = 5, maxCount = 50) {
        console.log('[PatternDetector] Запуск поиска повторяющихся паттернов...');
        
        // 1. Собираем статистику по классам
        const classStats = {};
        const allElements = document.querySelectorAll('*');
        
        allElements.forEach(el => {
            const classes = Array.from(el.classList);
            classes.forEach(cls => {
                // Игнорируем служебные классы
                if (cls.length < 3 || cls.startsWith('_')) return;
                
                if (!classStats[cls]) {
                    classStats[cls] = [];
                }
                classStats[cls].push(el);
            });
        });

        // 2. Фильтруем группы по количеству элементов
        const candidates = Object.entries(classStats)
            .filter(([cls, els]) => els.length >= minCount && els.length <= maxCount)
            .map(([cls, els]) => ({ className: cls, elements: els, count: els.length }))
            .sort((a, b) => b.count - a.count); // Сортируем по убыванию количества

        console.log(`[PatternDetector] Найдено ${candidates.length} кандидатов для анализа`);

        // 3. Проверяем "сигнатуру карточки" для каждого кандидата
        for (const candidate of candidates) {
            const signature = this.checkOfferSignature(candidate.elements);
            
            if (signature.isValid) {
                console.log(`[PatternDetector] ✓ Найден паттерн: .${candidate.className} (${candidate.count} элементов)`);
                console.log(`[PatternDetector] Сигнатура:`, signature);
                return `.${candidate.className}`;
            }
        }

        console.log('[PatternDetector] Паттерн не найден');
        return null;
    }

    /**
     * Проверяет, соответствуют ли элементы "сигнатуре" карточки оффера
     * @param {Array} elements - Массив DOM-элементов
     * @returns {Object} - Результат проверки с деталями
     */
    static checkOfferSignature(elements) {
        // Берем первые 5 элементов для проверки (или все, если меньше)
        const sampleSize = Math.min(5, elements.length);
        const sample = elements.slice(0, sampleSize);
        
        let hasImg = 0, hasButton = 0, hasLink = 0, hasText = 0, hasFinTerms = 0;
        
        const finKeywords = ['руб', '₽', '%', 'дн', 'день', 'месяц', 'год', 'ставка', 'сумма', 'срок'];
        
        for (const el of sample) {
            // Проверка изображения
            const img = el.querySelector('img');
            if (img && img.width > 30) hasImg++;
            
            // Проверка кнопки
            const button = el.querySelector('button, .btn, [class*="button"], [class*="btn"]');
            if (button) hasButton++;
            
            // Проверка ссылки
            const link = el.querySelector('a[href]');
            if (link && link.href && link.href.startsWith('http')) hasLink++;
            
            // Проверка текста
            const text = el.innerText || '';
            if (text.trim().length > 20) hasText++;
            
            // Проверка финансовых терминов
            const hasFinKeyword = finKeywords.some(kw => text.toLowerCase().includes(kw));
            if (hasFinKeyword) hasFinTerms++;
        }
        
        // Элемент считается валидным, если 80%+ имеют все признаки
        const threshold = Math.ceil(sampleSize * 0.8);
        
        const isValid = hasImg >= threshold && 
                       hasButton >= threshold && 
                       hasLink >= threshold && 
                       hasText >= threshold;
        
        return {
            isValid,
            sampleSize,
            threshold,
            stats: {
                hasImg,
                hasButton,
                hasLink,
                hasText,
                hasFinTerms
            }
        };
    }

    /**
     * Извлекает бренд из атрибутов изображения (alt, src)
     * @param {string} imageUrl - URL изображения
     * @param {string} altText - Alt-текст изображения
     * @returns {string|null} - Название бренда или null
     */
    static extractBrandFromImage(imageUrl, altText) {
        if (!imageUrl && !altText) return null;
        
        // Проверяем alt-текст
        if (altText && altText.length > 2 && altText.length < 30) {
            const cleaned = altText.toLowerCase()
                .replace(/logo|icon|image|brand|alt/gi, '')
                .trim();
            if (cleaned.length > 2) return cleaned;
        }
        
        // Проверяем имя файла в URL
        if (imageUrl) {
            try {
                const url = new URL(imageUrl);
                const filename = url.pathname.split('/').pop();
                const nameWithoutExt = filename.replace(/\.(png|jpg|jpeg|svg|gif|webp)$/i, '');
                const cleaned = nameWithoutExt
                    .replace(/logo|icon|brand|-|_/gi, ' ')
                    .trim();
                if (cleaned.length > 2 && cleaned.length < 30) return cleaned;
            } catch (e) {
                // Невалидный URL, игнорируем
            }
        }
        
        return null;
    }
}

// Экспортируем для использования в Node.js (если нужно)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PatternDetector;
}
