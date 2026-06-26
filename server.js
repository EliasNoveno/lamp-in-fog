// Вместо хранения currentUser в памяти, храним токен в localStorage
const TOKEN_KEY = 'fog_token';

// Функция для авторизованных запросов
async function authFetch(url, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) throw new Error('Not authenticated');
    
    return fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            'Authorization': `Bearer ${token}`
        }
    });
}

// В login:
const response = await authFetch('/api/login', { method: 'POST', body: JSON.stringify(...) });
const data = await response.json();
localStorage.setItem(TOKEN_KEY, data.token);
// И удаляем currentUser из глобальной переменной - используем только токен

// В logout:
localStorage.removeItem(TOKEN_KEY);
// Также отправляем запрос на /api/logout
