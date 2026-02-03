const fs = require('fs');
const path = require('path');

// Транслитерация
function transliterate(text) {
    const map = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh',
        'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
        'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
        'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ы': 'y', 'э': 'e', 'ю': 'yu', 'я': 'ya',
        'ь': '', 'ъ': ''
    };
    return text.toLowerCase().split('').map(char => map[char] || char).join('');
}

// Генерация вариаций (пробелы, дефисы, слитно)
function generateVariations(name) {
    const clean = name.toLowerCase().trim();
    const variations = new Set();
    variations.add(clean);

    // Удаляем точки и спецсимволы для вариаций
    const noSpecial = clean.replace(/[.()]/g, '');
    variations.add(noSpecial);

    // Если есть пробел или дефис
    if (clean.includes(' ') || clean.includes('-')) {
        const parts = clean.split(/[\s\-]/);
        variations.add(parts.join(' '));
        variations.add(parts.join('-'));
        variations.add(parts.join(''));
    }

    // Если есть точки (например Pay P.S.)
    if (clean.includes('.')) {
        variations.add(clean.replace(/\./g, ''));
        variations.add(clean.replace(/\./g, ' '));
    }

    return Array.from(variations);
}

// Примеры из mfo_names_list.md (Slug, RU, AltRU, EN)
const csvData = `ekapusta,еКапуста,е Капуста,Ekapusta
moneyman,Манимен,Money Man,Moneyman
zaymer,Займер,Робот Займер,Zaymer
limezaim,Лайм-Займ,Лайм Займ,LimeZaim
moneza,Монеза,Moneza,,
turbozaim,Турбозайм,TurboZaim,,
creditplus,CreditPlus,Кредит Плюс,,
platiza,Платиза,Platiza,,
payps,Pay P.S.,Пей ПС,,
ezaem,Езаем,Ezaem,,
kredito24,Kredito24,Кредито24,,
smartcredit,СмартКредит,SmartCredit,,
migkredit,МигКредит,MigCredit,,
4slovo,Честное слово,4slovo,,
otlnal,Отличные Наличные,Otlnal,,
srochnodengi,Срочноденьги,Srochnodengi,,
dengisrazy,Деньги Сразу,Dengisrazy,,
bistrodengi,Быстроденьги,Bistrodengi,,
webbankir,Вэббанкир,Webbankir,,
glavfinans,Главфинанс,Glavfinans,,
dozarplati,До Зарплаты,Dozarplati,,
joymoney,Джой Мани,JoyMoney,,
konga,Конга,Konga,,
oneclickmoney,OneClickMoney,Ван Клик Мани,,
greenmoney,ГринМани,GreenMoney,,
vivus,Вивус,Vivus,,
smsfinance,СМСФинанс,SMSFinance,,
zaymigo,Займиго,Zaymigo,,
microklad,Микроклад,Microklad,,
centrofinans,Центрофинанс,Centrofinans,,
web-zaim,Веб-Займ,Web-Zaim,,
finterra,Финтерра,Finterra,,
vivadengi,VIVA Деньги,Vivadengi,,
centrzaimov,ДоброЗайм,Центр Займов,,
hot-zaim,Хот-Займ,Hot-Zaim,,
fastmoney,Фастмани,Fastmoney,,
big-zaim,Биг-Займ,Big-Zaim,,
denginadom,Деньги на дом,Denginadom,,
alizaim,Али Займ,Alizaim,,
cashtoyou,CashToYou,Кеш ту ю,,
kviku,Квику,Kviku,,
europexpresscredit,Евро Экспресс Кредит,Europexpresscredit,,
zdeslegko-auto,Здесь Легко,Zdeslegko,,
creditstar,Кредит Стар,Creditstar,,
narcredit,НарКредит,Narcredit,,
maxcredit,Макс-Кредит,Maxcredit,,
carcapital24,Кар Капитал,Carcapital24,,
nadodeneg,Надо Денег,Nadodeneg,,
belkacredit,Белка Кредит,Belkacredit,,
robocredit,Робокредит,Robocredit,,
car-migcredit,МигКредит авто,Migcredit,,
zaymexpress,Займ Экспресс,Zaymexpress,,
carmoney-pts,CarMoney ПТС,Carmoney,,
cashpoint,Кэшпоинт,Cashpoint,,
sodejstvie,Содействие,Sodejstvie,,
afgfin,АФГ Финанс,Afgfin,,
zheldorzaim,Желдорзайм,Zheldorzaim,,
fanmoney,Фанмани,Fanmoney,,
finmoll,Финмолл,Finmoll,,
denga,Деньга,Denga,,
bistrodengi-avtolombard,Быстроденьги Авто,Bistrodengi,,
cashdrive-pts,Cashdrive ПТС,Cashdrive,,
papafinance,Папа Финанс,Papafinance,,
zaymirf,Займи РФ,Zaymirf,,
moneyfaktura,Манифактура,Moneyfaktura,,
dobrozaim-pod-zalog-pts,ДоброЗайм ПТС,Dobrozaim,,
credeo-pod-pts,Credeo ПТС,Credeo,,
smartcash,Умные Наличные,Smartcash,,
nalichnienalichnie,Наличные,Nalichnienalichnie,,
smartstart24,СмартСтарт,Smartstart,,
cashdrive,Cashdrive,Кешдрайв,,
chestnii-zaim,Честный Займ,Chestnii-zaim,,
caranga,Каранга,Caranga,,
boostra,Бустра,Boostra,,
chestnyj-nol,Честный Ноль,Chestnyj-nol,,
mscore,Mscore,Mediumscore,,
nebusfinance,Небус,Nebus,,
budgett,Budgett,Баджетт,,
adengi,АДеньги,Adengi,,
celfinansi,Целевые Финансы,Celfinansi,,
vdplatinum,ВД Платинум,Vdplatinum,,
microzaim,Микрозайм,Microzaim,,
mircash24,Мир Кэш,Mircash,,
krediska,Кредиска,Krediska,,
beriberu,Бери Беру,Beriberu,,
dengimigom,ДеньгиМигом,Dengimigom,,
mfobank,МФО Банк,Mfobank,,
svoiludi,Свои Люди,Svoiludi,,
495credit,495 Кредит,495credit,,
finfive,Финфайв,Finfive,,
jekspressdengi,Экспрессденьги,Jekspressdengi,,
carmoney,CarMoney,Кармани,,
privet-sosed,Привет Сосед,Privet-sosed,,
beeon,Beeon,Бион,,
skbfinance,СКБ Финанс,Skbfinance,,
creddy,Creddy,Кредди,,
ykky,Юкки,Ykky,,
erck,ЕРЦК,Erck,,
korona,Корона,Korona,,
ilma,Илма,Ilma,,
zaimirub,Займи Руб,Zaimirub,,
prostoyvopros,Простой вопрос,Prostoyvopros,,
capitalina,Капиталина,Capitalina,,
papa-zaim,Папа Займ,Papa-zaim,,
bankomato,Банкомато,Bankomato,,
skelamoney,Скела Мани,Skelamoney,,
hurmacredit,Хурма Кредит,Hurmacredit,,
acado,Акадо,Acado,,
likezaim67,ЛайкЗайм,Likezaim,,
beliedengi,Белые Деньги,Beliedengi,,
tvoizaymy,Твои Займы,Tvoizaymy,,
bankadeneg,Банка Денег,Bankadeneg,,
vashinvestor,Ваш инвестор,Vashinvestor,,
yasen,Ясень,Yasen,,
colibridengi,Колибри Деньги,Colibridengi,,
creditsmile,Кредит Смайл,Creditsmile,,
uabramovicha,У Абрамовича,Uabramovicha,,
kosmiczaym,Космизайм,Kosmiczaym,,
mrcash,Мистер Кэш,Mrcash,,
zaimmobile,Займ Мобайл,Zaimmobile,,
finters,Финтерс,Finters,,
zaemru,Заем.ру,Zaemru,,
migomzaim,Мигомзайм,Migomzaim,,
bro22,Бро22,Bro22,,
stranaexpress,Страна Экспресс,Stranaexpress,,
rocketman,РокетМэн,Rocketman,,
davaka,Давака,Davaka,,
credit2day,Кредит2дей,Credit2day,,
cashiro,Кэширо,Cashiro,,
tezfinance,Тез Финанс,Tezfinance,,
smartzaym-pts,Смарт Займ ПТС,Smartzaym,,
drivezaim-pts,Драйв Займ ПТС,Drivezaim,,
cashmagnit,Кэшмагнит,Cashmagnit,,
probalance,Пробаланс,Probalance,,
mirzaimov,Мир Займов,Mirzaimov,,
dengiok,Деньги ОК,Dengiok,,
eqzaim,Экзайм,Eqzaim,,
kekas,Кекас,Kekas,,
credit365,Кредит 365,Credit365,,
skorzaym,Скорзайм,Skorzaym,,
megadengi,МегаДеньги,Megadengi,,
kitcredit,Кит Кредит,Kitcredit,,
ecozaym,Экозайм,Ecozaym,,
snapcredit,Снап Кредит,Snapcredit,,
dopoluchkino,Дополучкино,Dopoluchkino,,
freecapital,Фри Капитал,Freecapital,,
likemoney,Лайк Мани,Likemoney,,
vozmika,Возьмика,Vozmika,,`;

// Загружаем текущие алиасы
const normalizationPath = path.resolve(__dirname, '../src/services/normalization.js');

const currentAliases = {};

// Обрабатываем CSV и добавляем новые МФО
const rows = csvData.split('\n');
rows.forEach(row => {
    if (!row.trim()) return;
    const cols = row.split(',').map(c => c.trim()).filter(c => c);
    if (cols.length === 0) return;

    const slug = cols[0];
    const mainName = cols[1] || slug;
    const extraAliases = cols.slice(1);

    // Используем mainName как ключ
    if (!currentAliases[mainName]) {
        currentAliases[mainName] = [];
    }

    extraAliases.forEach(a => {
        if (!currentAliases[mainName].includes(a.toLowerCase())) {
            currentAliases[mainName].push(a.toLowerCase());
        }
    });

    // Добавляем слаг (очищенный от zaym-)
    const cleanSlug = slug.replace('zaym-', '');
    if (!currentAliases[mainName].includes(cleanSlug)) {
        currentAliases[mainName].push(cleanSlug);
    }
});

// Финальная обработка: дефисы, транскрипция, уникальность
const finalAliases = {};
for (const [brand, aliases] of Object.entries(currentAliases)) {
    const aliasSet = new Set();
    
    aliases.forEach(a => {
        const vars = generateVariations(a);
        vars.forEach(v => {
            aliasSet.add(v);
            aliasSet.add(transliterate(v));
        });
    });

    const brandVars = generateVariations(brand);
    brandVars.forEach(v => {
        aliasSet.add(v);
        aliasSet.add(transliterate(v));
    });

    finalAliases[brand] = Array.from(aliasSet).sort();
}

// Формируем контент файла
let newContent = `/**
 * Сервис для сопоставления разных названий офферов в единый бренд.
 */

const BRAND_ALIASES = {
`;

for (const [brand, aliases] of Object.entries(finalAliases)) {
    newContent += `    '${brand.replace(/'/g, "\\'")}': ${JSON.stringify(aliases)},\n`;
}

newContent += `};

class NormalizationService {
    static BRAND_ALIASES = BRAND_ALIASES;

    /**
     * Превращает любое название в эталонное имя бренда.
     */
    static normalize(name, url = '') {
        if (!name) return 'Unknown';

        let cleanName = name.toLowerCase()
            .replace(/['"«»]/g, '')
            .replace(/(мфо|мкк|ооо|зао|пао|мфк)/gi, '')
            .trim();

        // 1. Проверяем по справочнику алиасов
        for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
            if (aliases.some(a => cleanName.includes(a.toLowerCase()))) {
                return brand;
            }
        }

        // 2. Если в имени нет зацепок, проверяем URL
        if (url) {
            const lowUrl = url.toLowerCase();
            for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
                if (aliases.some(a => lowUrl.includes(a.toLowerCase()))) {
                    return brand;
                }
            }
        }

        // 3. Если ничего не подошло, возвращаем причесанное исходное имя
        return name.split(/[.,!?;|]/)[0].trim().substring(0, 30);
    }
}

module.exports = { NormalizationService, BRAND_ALIASES };
`;

fs.writeFileSync(normalizationPath, newContent);
console.log('normalization.js успешно обновлен!');
