const error = (message, status) => Object.assign(new Error(message), { status });

export async function fetchDataset(groupId, { url = process.env.ORGANIZER_API_URL, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (typeof groupId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(groupId))
    throw error('group_id: от 1 до 100 букв, цифр, дефисов или подчёркиваний', 400);
  if (!url) throw error('На сервере не настроен ORGANIZER_API_URL', 503);
  let target;
  try { target = new URL(url); } catch { throw error('Неверная настройка ORGANIZER_API_URL', 503); }
  if (target.protocol !== 'https:') throw error('ORGANIZER_API_URL должен использовать HTTPS', 503);
  target.searchParams.set('group_id', groupId);
  let payload;
  try {
    const response = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) throw error(`API организаторов: HTTP ${response.status}`, 502);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 20 * 1024 * 1024) throw error('Ответ API превышает 20 МБ', 502);
    try { payload = JSON.parse(raw); } catch { throw error('API организаторов вернул не JSON', 502); }
  } catch (cause) {
    if (cause.status) throw cause;
    if (['TimeoutError', 'AbortError'].includes(cause.name)) throw error('API организаторов не ответил за отведённое время', 504);
    throw error('Не удалось подключиться к API организаторов', 502);
  }
  if (!payload || payload.isSuccess !== true || payload.data?.dataset_group_id !== groupId
    || !Array.isArray(payload.data?.records) || !Number.isInteger(payload.data.total_records)
    || payload.data.total_records !== payload.data.records.length)
    throw error('API организаторов вернул ошибку или неполный набор', 502);
  return { group_id: groupId, records: payload.data.records };
}
