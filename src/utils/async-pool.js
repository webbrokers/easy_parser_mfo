/**
 * Ограничивает количество параллельно выполняемых асинхронных задач.
 * 
 * @param {number} concurrency - Максимальное количество параллельных задач.
 * @param {Array} array - Массив входных данных.
 * @param {Function} iteratorFn - Функция, которая будет вызвана для каждого элемента массива.
 * @returns {Promise<Array>} - Массив результатов.
 */
async function asyncPool(concurrency, array, iteratorFn) {
  const ret = [];
  const executing = new Set();
  
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item, array));
    ret.push(p);
    executing.add(p);
    
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);
    
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  
  return Promise.all(ret);
}

module.exports = { asyncPool };
