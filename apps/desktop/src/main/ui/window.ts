import {
  BrowserWindow,
  Menu,
  dialog,
  nativeImage,
  app,
  screen,
  type MenuItemConstructorOptions,
} from 'electron';
import { PRELOAD_PATH } from '../paths.js';
import { adoptCheckoutWindow, checkoutWindowOpenHandler, closeCheckoutWindows } from '../payments/checkout-window.js';

let mainWindow: BrowserWindow | null = null;

// One resizable window for every view. The minimum keeps the nav rail, the
// chat list and a readable conversation side by side.
const WINDOW_SIZE = { width: 1240, height: 900, minWidth: 920, minHeight: 600 };

export interface WindowConfig {
  appName: string;
  appIconPath: string | undefined;
  isDev: boolean;
  rendererUrl: string;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createWindow(config: WindowConfig): void {
  // Fits the display it opens on, for small laptop screens.
  const workArea = screen.getPrimaryDisplay().workArea;
  const macosWindowChrome = process.platform === 'darwin'
    ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 14, y: 16 },
    }
    : {};

  mainWindow = new BrowserWindow({
    width: Math.min(WINDOW_SIZE.width, workArea.width),
    height: Math.min(WINDOW_SIZE.height, workArea.height),
    minWidth: WINDOW_SIZE.minWidth,
    minHeight: WINDOW_SIZE.minHeight,
    useContentSize: true,
    autoHideMenuBar: process.platform !== 'darwin',
    title: config.appName,
    icon: config.appIconPath,
    backgroundColor: '#ececec',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
    ...macosWindowChrome,
  });

  // Sized popups (the Fun checkout's card/sign-in flows) open as app-owned
  // child windows so they can be closed when the payment lands; everything
  // else leaves for the system browser.
  mainWindow.webContents.setWindowOpenHandler(checkoutWindowOpenHandler);
  mainWindow.webContents.on('did-create-window', (child) => adoptCheckoutWindow(child));

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', false);
  });
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window-focus-change', true);
  });
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-focus-change', false);
  });

  void mainWindow.loadURL(config.rendererUrl);

  mainWindow.webContents.on('did-finish-load', () => {
    if (!config.isDev || !mainWindow) return;
    void mainWindow.webContents
      .executeJavaScript('Boolean(window.antseedDesktop)', true)
      .then((ok) => {
        console.log(`[desktop] preload bridge ${ok ? 'ready' : 'missing'}`);
      })
      .catch((err) => {
        console.error(`[desktop] preload bridge check failed: ${String(err)}`);
      });
  });

  if (config.isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Allow opening DevTools in production for debugging (Cmd+Option+I / Ctrl+Shift+I).
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const devToolsShortcut =
      (input.meta && input.alt && input.key === 'i') ||   // macOS: Cmd+Option+I
      (input.control && input.shift && input.key === 'I'); // Windows/Linux: Ctrl+Shift+I
    if (devToolsShortcut && mainWindow) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    // Windows: Ctrl++ sends Ctrl+Shift+= which does not match the viewMenu's
    // CmdOrCtrl+= zoom-in accelerator. Handle it explicitly so zoom is symmetrical.
    if (
      input.type === 'keyDown' &&
      input.control &&
      !input.alt &&
      input.key === '+' &&
      mainWindow
    ) {
      mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeCheckoutWindows();
  });
}

function showAboutDialog(appName: string, appIconPath: string | undefined): void {
  void dialog.showMessageBox({
    type: 'none',
    title: `About ${appName}`,
    message: appName,
    detail: `Version ${app.getVersion()}`,
    buttons: ['OK'],
    icon: appIconPath ? nativeImage.createFromPath(appIconPath) : undefined,
  });
}

export function createApplicationMenu(appName: string, appIconPath: string | undefined): void {
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
      {
        label: appName,
        submenu: [
          { label: `About ${appName}`, click: () => showAboutDialog(appName, appIconPath) },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${appName}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${appName}` },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: `About ${appName}`, click: () => showAboutDialog(appName, appIconPath) },
        ],
      },
    ]
    : [
      {
        role: 'fileMenu',
      },
      {
        role: 'editMenu',
      },
      {
        role: 'viewMenu',
      },
      {
        role: 'windowMenu',
      },
      {
        role: 'help',
        submenu: [
          { label: `About ${appName}`, click: () => showAboutDialog(appName, appIconPath) },
        ],
      },
    ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
