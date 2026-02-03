const xml = `...`; // Содержимое sitemap
const urls = xml.match(/<loc>(https:\/\/brobank.ru\/zaym-[^<]+)<\/loc>/g)
    .map(loc => loc.replace(/<\/?loc>/g, ''))
    .filter(url => !url.includes('/comments/') && 
                   !url.includes('/faq/') && 
                   !url.includes('/contacts/') && 
                   !url.includes('/profile/') && 
                   !url.includes('/promokody/') && 
                   !url.includes('/goryachaya-liniya/'));
console.log(JSON.stringify([...new Set(urls)], null, 2));
