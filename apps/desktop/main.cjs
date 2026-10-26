// Electron main process: hosts the shared web client and provides the
// Web Bluetooth device chooser that Chrome normally shows itself.
const { app, BrowserWindow, ipcMain, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEV_URL = process.env.VELO_DEV_URL;
const clientDir = app.isPackaged ? path.join(process.resourcesPath, 'client') : path.join(__dirname, '..', 'client', 'dist');

// A privileged custom scheme gives the page a secure origin (required for Web Bluetooth)
// without serving it over file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Web Bluetooth is on by default on Windows and macOS; Linux (dev only) needs this flag.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-experimental-web-platform-features');
}

// The app was called "Velo Sim": its rides, settings and garage stay in that folder after the rename to WFR.
app.setPath('userData', path.join(app.getPath('appData'), 'Velo Sim'));

/** @type {((deviceId: string) => void) | null} */
let pendingBluetoothCallback = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'WFR – Was für Rolle!!',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep trainer control running when the window is in the background
    },
  });

  // Chrome shows its own chooser; Electron fires this event repeatedly while scanning instead.
  win.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    if (pendingBluetoothCallback && pendingBluetoothCallback !== callback) {
      pendingBluetoothCallback('');
    }
    pendingBluetoothCallback = callback;
    const devices = deviceList.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName }));
    win.webContents.send('bluetooth-devices', devices);
  });

  // Links that open a new window (e.g. Strava login) go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadURL('app://velo/index.html');
  }
  return win;
}

ipcMain.on('bluetooth-select', (_event, deviceId) => {
  if (pendingBluetoothCallback) {
    pendingBluetoothCallback(String(deviceId));
    pendingBluetoothCallback = null;
  }
});

ipcMain.on('open-external', (_event, url) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
});

ipcMain.on('bluetooth-cancel', () => {
  if (pendingBluetoothCallback) {
    pendingBluetoothCallback('');
    pendingBluetoothCallback = null;
  }
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.normalize(path.join(clientDir, relative));
    const rel = path.relative(clientDir, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Windows may ask for pairing confirmation; trainers and HR straps use "Just Works".
  session.defaultSession.setBluetoothPairingHandler?.((details, callback) => {
    callback({ confirmed: details.pairingKind === 'confirm' });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
