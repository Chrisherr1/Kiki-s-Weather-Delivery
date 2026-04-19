// ─────────────────────────────────────────────────────────────────────────────
// main.js — Electron main process (orchestrator)
//
// Owns all mutable state and wires together:
//   tray.js           — menu bar icon and window positioning
//   src/weather.js    — API fetching and rain state analysis
//   src/notifications.js — OS notification logic
// ─────────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, ipcMain, protocol } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'

import { createTray } from './src/tray.js'
import { fetchWeatherData } from './src/weather.js'

const currentDirectory  = dirname(fileURLToPath(import.meta.url))

// In production, unpacked assets live in app.asar.unpacked/.
// process.resourcesPath is the reliable cross-platform way to find that directory.
// In dev (npm start), there is no asar so we use currentDirectory directly.
let unpackedDirectory

if (app.isPackaged) {
  unpackedDirectory = join(process.resourcesPath, 'app.asar.unpacked')
} else {
  unpackedDirectory = currentDirectory
}

config({ path: join(currentDirectory, '.env') })

const APP_NAME      = "Kiki's Weather Delivery"
const APP_ICON      = join(unpackedDirectory, 'renderer', 'Icon.jpg')
const APP_TRAY_ICON = join(unpackedDirectory, 'renderer', 'TrayIcon.png')

const COMPACT_WINDOW_WIDTH   = 320
const COMPACT_WINDOW_HEIGHT  = 200
const EXPANDED_WINDOW_WIDTH  = 560
const EXPANDED_WINDOW_HEIGHT = 720
const POLL_INTERVAL_MS       = 5 * 60 * 1000 // 5 minutes

const BREEZY_MPH = 15 // thresholds for wind notifications;
const WINDY_MPH  = 25 // thresholds for wind notifications;


// ── App state — owned here, passed by reference into src/ modules ─────────────
let mainWindow   = null
let tray         = null
let userLocation = { lat: null, lng: null, city: '', region: '' }

const rainState    = { active: false, coming: false, stopping: false }
const windState    = { windy: false, breezy: false }
const morningState = { lastDate: '' }
const stormState   = { active: false }
const uvState      = { active: false }

// ── Convenience wrapper ───────────────────────────────────────────────────────
function doFetchWeather() {
  fetchWeatherData(mainWindow, tray, userLocation, rainState, windState, morningState, stormState, uvState, APP_ICON, APP_NAME, BREEZY_MPH, WINDY_MPH)
}
// ── Custom asset:// protocol ──────────────────────────────────────────────────

protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { secure: true, standard: true, supportFetchAPI: true } },
])
// ── Window creation ───────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:       COMPACT_WINDOW_WIDTH,
    height:      COMPACT_WINDOW_HEIGHT,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow:   false,
    resizable:   false,
    show:        false,
    icon:        APP_ICON,
    webPreferences: {
      preload:          join(currentDirectory, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setWindowButtonVisibility(false)
  }

  mainWindow.on('blur', function() {
    if (mainWindow.webContents.isDevToolsOpened()) { return }
    mainWindow.hide()
  })

  mainWindow.loadFile(join(currentDirectory, 'renderer', 'index.html'))
}


// ── Location resolution ───────────────────────────────────────────────────────

const LOCATION_RETRY_DELAY_MS = 30 * 1000  // retry after 30 seconds if IP lookup fails
const LOCATION_MAX_RETRIES    = 3

async function resolveUserLocation(retryCount = 0) {
  if (process.env.LAT && process.env.LON) {
    userLocation = {
      lat:    parseFloat(process.env.LAT),
      lng:    parseFloat(process.env.LON),
      city:   process.env.CITY   || '',
      region: process.env.REGION || '',
    }
    console.log('[location] from .env:', userLocation.city, userLocation.lat, userLocation.lng)
    mainWindow.webContents.send('location-name', { city: userLocation.city, region: userLocation.region })
    doFetchWeather()
    return
  }

  try {
    console.log('[location] resolving via IP…')
    const response = await fetch('http://ip-api.com/json/?fields=lat,lon,city,regionName')
    if (!response.ok) { throw new Error('ip-api returned status ' + response.status) }

    const responseData = await response.json()
    userLocation = {
      lat:    responseData.lat,
      lng:    responseData.lon,
      city:   responseData.city       || '',
      region: responseData.regionName || '',
    }

    console.log('[location]', userLocation.city + ',', userLocation.region, '(' + userLocation.lat + ', ' + userLocation.lng + ')')
    mainWindow.webContents.send('location-name', { city: userLocation.city, region: userLocation.region })
    doFetchWeather()

  } catch (locationError) {
    console.error('[location] failed:', locationError.message)

    if (retryCount < LOCATION_MAX_RETRIES) {
      console.log('[location] retrying in 30s… (attempt ' + (retryCount + 1) + ' of ' + LOCATION_MAX_RETRIES + ')')
      mainWindow.webContents.send('weather-error', 'Could not resolve location, retrying…')
      setTimeout(function() { resolveUserLocation(retryCount + 1) }, LOCATION_RETRY_DELAY_MS)
    } else {
      console.error('[location] all retries exhausted')
      mainWindow.webContents.send('weather-error', 'Could not resolve location. Add LAT/LON to .env as a fallback.')
    }
  }
}


// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('toggle-expand', function() {
  mainWindow.webContents.send('expanded-change', false)
  mainWindow.hide()
})

ipcMain.on('refresh', function() {
  doFetchWeather()
})


// ── App Startup ─────────────────────────────────────────────────────────────
// basically app.listen equalent for Electron; 
// this is where we set up the tray, main window, and start the initial weather fetch and location resolution.
app.whenReady().then(function() {

  // Register the app to launch automatically on login
  app.setLoginItemSettings({ openAtLogin: true })

  if (process.platform === 'darwin') {
    app.dock.setIcon(APP_ICON)
    app.dock.hide()
  }

  protocol.handle('asset', async function(request) {
    const requestUrl  = new URL(request.url)
    const folderName  = requestUrl.hostname
    const filePath    = requestUrl.pathname
    const fullPath = join(unpackedDirectory, folderName, filePath)

    const mimeTypes = {
      gif:  'image/gif',
      png:  'image/png',
      jpg:  'image/jpeg',
      svg:  'image/svg+xml',
      ttf:  'font/truetype',
      mp4:  'video/mp4',
      webm: 'video/webm',
    }

    const { readFile } = await import('fs/promises')
    try {
      const fileContents  = await readFile(fullPath)
      const fileExtension = fullPath.split('.').pop().toLowerCase()
      const contentType   = mimeTypes[fileExtension] || 'application/octet-stream'
      return new Response(fileContents, { headers: { 'Content-Type': contentType } })
    } catch (readError) {
      console.error('[asset] not found:', fullPath)
      return new Response(null, { status: 404 })
    }
  })

  createWindow()

  tray = createTray(mainWindow, APP_TRAY_ICON, APP_NAME, EXPANDED_WINDOW_WIDTH, EXPANDED_WINDOW_HEIGHT, doFetchWeather)

  mainWindow.webContents.once('did-finish-load', resolveUserLocation)

  setInterval(doFetchWeather, POLL_INTERVAL_MS)
})

app.on('window-all-closed', function() {
  // Tray app — stays alive until user quits via right-click menu.
})

app.on('activate', function() {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
