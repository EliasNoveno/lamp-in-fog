const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    // Игнорируем ошибки сертификата (для локальной разработки)
    app.commandLine.appendSwitch('ignore-certificate-errors');
    
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: path.join(__dirname, 'icon.png')
    });

    const url = 'https://localhost:3002';
    console.log('🔗 Loading:', url);
    mainWindow.loadURL(url);
    mainWindow.setMenuBarVisibility(false);
    
    // Отладка — если хочешь видеть что происходит
    // mainWindow.webContents.openDevTools();
    
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
