const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: path.join(__dirname, 'icon.png')
    });

    // ПРАВИЛЬНЫЙ URL — твой сервер на HTTPS и порту 3002
    const url = 'https://localhost:3002';
    
    console.log('🔗 Loading:', url);
    mainWindow.loadURL(url);
    
    // Открываем DevTools для отладки (можно убрать потом)
    mainWindow.webContents.openDevTools();
    
    mainWindow.setMenuBarVisibility(false);
    
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('❌ Failed to load:', errorCode, errorDescription);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
