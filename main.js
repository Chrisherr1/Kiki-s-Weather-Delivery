// ─────────────────────────────────────────────────────────────────────────────
// main.js — Electron main process
//
// Responsibilities:
//   - Live in the macOS menu bar (or Windows system tray) as a Tray icon
//   - Show current temperature as menu bar text next to the icon
//   - Click the tray icon to reveal the compact pill; click again to hide
//   - Click the compact pill to expand the detail panel
//   - Resolve the user's location (env override → IP fallback)
//   - Poll Kiki's Weather Delivery every 10 min and forward data to the renderer via IPC
//   - Fire OS notifications on rain state transitions
// ─────────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, ipcMain, Notification, screen, protocol, Tray, Menu, nativeImage } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

config()

const APP_NAME  = "Kiki's Weather Delivery"
const APP_ICON  = join(currentDirectory, 'renderer', 'Icon.jpg')


// ── Window dimensions ─────────────────────────────────────────────────────────

const COMPACT_WINDOW_WIDTH   = 320
const COMPACT_WINDOW_HEIGHT  = 200
const EXPANDED_WINDOW_WIDTH  = 560
const EXPANDED_WINDOW_HEIGHT = 720
const POLL_INTERVAL_MS       = 5 * 60 * 1000  // 5 minutes


// ── App state ─────────────────────────────────────────────────────────────────

let mainWindow     = null
let tray           = null
let lastTrayBounds = null  // remembered so toggle-expand can re-center the window
let isExpanded     = false
let userLocation   = { lat: null, lng: null, city: '', region: '' }

// Rain state — tracked across polls so notifications only fire on transitions,
// not on every poll while the condition persists
let previouslyRainActive   = false
let previouslyRainComing   = false
let previouslyRainStopping = false

// Wind state — same pattern as rain, notifications only on transitions
let previouslyBreezy = false
let previouslyWindy  = false

// Morning briefing — stores today's date string so it only fires once per day
let lastMorningBriefingDate = ''

// Wind speed thresholds (mph)
const BREEZY_MPH = 15   // light breeze worth mentioning
const WINDY_MPH  = 25   // genuinely windy


// ── Custom asset:// protocol ──────────────────────────────────────────────────
// Must be registered before app.whenReady().
// Lets the renderer load local files (fonts, gifs) without file:// CSP issues.
// Usage:  asset://renderer/Windy.gif  →  <project root>/renderer/Windy.gif

protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { secure: true, standard: true, supportFetchAPI: true } },
])


// ── Tray icon image ───────────────────────────────────────────────────────────
// Builds a small circular dot from a raw RGBA buffer — no image file needed.
// On macOS, setTemplateImage(true) tells the OS to auto-invert it for
// light / dark menu bars.

function createTrayIconImage() {
  const iconSize    = 44          // 44px rendered at scaleFactor 2 = crisp on retina
  const pixelBuffer = Buffer.alloc(iconSize * iconSize * 4, 0)  // start fully transparent

  const centerX = iconSize / 2
  const centerY = iconSize / 2
  const radius  = 7              // dot radius in logical pixels (≈ 3.5 pt on retina)

  for (let pixelY = 0; pixelY < iconSize; pixelY++) {
    for (let pixelX = 0; pixelX < iconSize; pixelX++) {
      const distanceFromCenter = Math.sqrt(
        Math.pow(pixelX + 0.5 - centerX, 2) +
        Math.pow(pixelY + 0.5 - centerY, 2)
      )
      const bufferIndex = (pixelY * iconSize + pixelX) * 4

      if (distanceFromCenter < radius) {
        pixelBuffer[bufferIndex]     = 0    // R — black so template image works
        pixelBuffer[bufferIndex + 1] = 0    // G
        pixelBuffer[bufferIndex + 2] = 0    // B
        pixelBuffer[bufferIndex + 3] = 255  // A — fully opaque
      }
    }
  }

  const iconImage = nativeImage.createFromBuffer(pixelBuffer, {
    width:       iconSize,
    height:      iconSize,
    scaleFactor: 2.0,   // marks this as a @2x asset
  })

  iconImage.setTemplateImage(true)  // macOS: OS handles dark / light adaptation
  return iconImage
}


// ── Window positioning ────────────────────────────────────────────────────────

// Returns the x / y position to place the widget directly below the tray icon
// (macOS) or just above the taskbar / system tray (Windows).
function getPositionBelowTray(trayBounds, windowWidth, windowHeight) {
  const primaryDisplay = screen.getPrimaryDisplay()
  const displayBounds  = primaryDisplay.bounds

  if (process.platform === 'win32') {
    const workArea = primaryDisplay.workAreaSize
    const windowX  = Math.round(trayBounds.x + trayBounds.width / 2 - windowWidth / 2)
    const windowY  = workArea.height - windowHeight - 4
    return {
      x: Math.max(8, Math.min(windowX, displayBounds.width  - windowWidth  - 8)),
      y: windowY,
    }
  }

  // macOS / Linux — drop down below the menu bar icon, right-aligned to the icon
  const windowX = displayBounds.width - windowWidth - 8
  const windowY = trayBounds.y + trayBounds.height + 4
  return {
    x: Math.max(8, Math.min(windowX, displayBounds.width - windowWidth - 8)),
    y: windowY,
  }
}


// ── Rain state analysis ───────────────────────────────────────────────────────

// Returns which rain states are active right now based on current + next few hours
function analyzeRainStates(currentConditions, hourlyDataArray) {
  const hourlyItems      = hourlyDataArray || []
  const precipIntensity  = currentConditions.precipIntensity ?? 0
  const nextThreeHours   = hourlyItems.slice(0, 3)

  const isRainingNow = precipIntensity > 0.1

  // Rain is coming if it's not raining now but the next few hours show rain
  const isRainComing = !isRainingNow && nextThreeHours.some(function(hourlyItem) {
    return (hourlyItem.precipIntensity ?? 0) > 0.1
  })

  // Rain is stopping if it's raining now but the next few hours show it clearing
  const isRainStopping = isRainingNow && nextThreeHours.slice(1).every(function(hourlyItem) {
    return (hourlyItem.precipIntensity ?? 0) <= 0.05
  })

  return {
    active:   isRainingNow && !isRainStopping,
    coming:   isRainComing,
    stopping: isRainStopping,
  }
}


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
    icon:        APP_ICON,   // hidden on launch — revealed when tray icon is clicked
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

  // Standard tray-app behaviour: hide (not close) the window when it loses focus
  mainWindow.on('blur', function() {
    if (mainWindow.webContents.isDevToolsOpened()) return
    mainWindow.hide()
  })

  mainWindow.loadFile(join(currentDirectory, 'renderer', 'index.html'))
}


// ── Tray setup ────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(createTrayIconImage())
  tray.setToolTip(APP_NAME + ' — click to open')

  // Left-click: show the expanded panel directly, or hide if already visible
  tray.on('click', function(clickEvent, trayBounds) {
    lastTrayBounds = trayBounds

    if (mainWindow.isVisible()) {
      mainWindow.hide()
      return
    }

    // Always open straight to the expanded panel — no compact pill step
    isExpanded = true
    const windowPosition = getPositionBelowTray(trayBounds, EXPANDED_WINDOW_WIDTH, EXPANDED_WINDOW_HEIGHT)
    mainWindow.setBounds({
      x:      windowPosition.x,
      y:      windowPosition.y,
      width:  EXPANDED_WINDOW_WIDTH,
      height: EXPANDED_WINDOW_HEIGHT,
    })
    mainWindow.webContents.send('expanded-change', true)
    mainWindow.show()
    mainWindow.focus()
  })

  // Right-click: small context menu for manual refresh and quit
  tray.on('right-click', function() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Refresh Weather',
        click: function() { fetchWeatherData() },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: function() { app.quit() },
      },
    ])
    tray.popUpContextMenu(contextMenu)
  })
}


// ── Location resolution ───────────────────────────────────────────────────────

async function resolveUserLocation() {
  // Env vars let you hardcode a location — useful in dev or when IP lookup fails
  if (process.env.LAT && process.env.LON) {
    userLocation = {
      lat:    parseFloat(process.env.LAT),
      lng:    parseFloat(process.env.LON),
      city:   process.env.CITY   || '',
      region: process.env.REGION || '',
    }
    console.log('[location] from .env:', userLocation.city, userLocation.lat, userLocation.lng)
    mainWindow.webContents.send('location-name', { city: userLocation.city, region: userLocation.region })
    fetchWeatherData()
    return
  }

  try {
    console.log('[location] resolving via IP…')
    const response = await fetch('http://ip-api.com/json/?fields=lat,lon,city,regionName')
    if (!response.ok) throw new Error('ip-api returned status ' + response.status)

    const responseData = await response.json()
    userLocation = {
      lat:    responseData.lat,
      lng:    responseData.lon,
      city:   responseData.city       || '',
      region: responseData.regionName || '',
    }
    console.log('[location]', userLocation.city + ',', userLocation.region, '(' + userLocation.lat + ', ' + userLocation.lng + ')')
    mainWindow.webContents.send('location-name', { city: userLocation.city, region: userLocation.region })
    fetchWeatherData()
  } catch (locationError) {
    console.error('[location] failed:', locationError.message)
    mainWindow.webContents.send('weather-error', 'Could not resolve location. Add LAT/LON to .env as a fallback.')
  }
}


// ── Weather fetching ──────────────────────────────────────────────────────────

async function fetchWeatherData() {
  if (!userLocation.lat) return

  const apiKey = process.env.PIRATE_WEATHER_KEY
  if (!apiKey) {
    mainWindow.webContents.send('weather-error', 'Missing PIRATE_WEATHER_KEY in .env')
    return
  }

  const apiUrl = 'https://api.pirateweather.net/forecast/'
    + apiKey + '/'
    + userLocation.lat + ',' + userLocation.lng
    + '?exclude=minutely,flags&units=us'

  try {
    const response = await fetch(apiUrl)
    if (!response.ok) throw new Error('HTTP ' + response.status)

    const weatherData       = await response.json()
    const currentConditions = weatherData.currently

    fireRainNotifications(currentConditions, weatherData.hourly?.data)
    fireWindNotifications(currentConditions)
    fireMorningBriefing(weatherData)
    mainWindow.webContents.send('weather-update', weatherData)
    console.log('[weather]', currentConditions.summary)

    // Show current temperature next to the menu bar icon (macOS only — setTitle
    // is a macOS-specific Tray feature; on Windows it would just set the tooltip)
    if (tray && process.platform === 'darwin') {
      tray.setTitle(' ' + Math.round(currentConditions.temperature) + '°')
    }
  } catch (fetchError) {
    console.error('[weather] fetch failed:', fetchError.message)
    mainWindow.webContents.send('weather-error', 'Fetch failed: ' + fetchError.message)
  }
}

// Fires a notification only when a rain state changes (not every poll)
function fireRainNotifications(currentConditions, hourlyDataArray) {
  const rainStates = analyzeRainStates(currentConditions, hourlyDataArray)

  if (rainStates.active   && !previouslyRainActive) {
    new Notification({ icon: APP_ICON, title: APP_NAME, body: '🌧 It\'s raining now.' }).show()
  }
  if (rainStates.coming   && !previouslyRainComing) {
    new Notification({ icon: APP_ICON, title: APP_NAME, body: '🌂 Rain on the way in the next hour.' }).show()
  }
  if (rainStates.stopping && !previouslyRainStopping) {
    new Notification({ icon: APP_ICON, title: APP_NAME, body: '🌤 Rain is clearing up soon.' }).show()
  }

  previouslyRainActive   = rainStates.active
  previouslyRainComing   = rainStates.coming
  previouslyRainStopping = rainStates.stopping
}

// Fires a notification when wind picks up or dies down
function fireWindNotifications(currentConditions) {
  const windSpeed = currentConditions.windSpeed || 0

  const isWindy  = windSpeed >= WINDY_MPH
  const isBreezy = windSpeed >= BREEZY_MPH && !isWindy

  if (isWindy && !previouslyWindy) {
    new Notification({ icon: APP_ICON, title: APP_NAME, body: '💨 It\'s windy out — ' + Math.round(windSpeed) + ' mph.' }).show()
  } else if (isBreezy && !previouslyBreezy && !previouslyWindy) {
    new Notification({ icon: APP_ICON, title: APP_NAME, body: '🍃 Getting breezy — ' + Math.round(windSpeed) + ' mph.' }).show()
  }

  // Notify when wind calms back down from windy
  if (!isWindy && !isBreezy && previouslyWindy) {
    new Notification({ icon: APP_ICON, title: APP_NAME, body: '😌 Wind has calmed down.' }).show()
  }

  previouslyWindy  = isWindy
  previouslyBreezy = isBreezy
}


// Fires once per day during the 6 AM – 9 AM window with a full day summary
function fireMorningBriefing(weatherData) {
  const currentHour     = new Date().getHours()
  const todayDateString = new Date().toDateString()

  // if (currentHour < 6 || currentHour >= 9)              return  // TEMP: disabled for preview
  if (lastMorningBriefingDate === todayDateString)       return  // already sent today

  const currentConditions = weatherData.currently
  const todayForecast     = weatherData.daily && weatherData.daily.data && weatherData.daily.data[0]
  if (!todayForecast) return

  const currentTemp   = Math.round(currentConditions.temperature)
  const conditions    = currentConditions.summary || ''
  const highTemp      = Math.round(todayForecast.temperatureHigh)
  const lowTemp       = Math.round(todayForecast.temperatureLow)
  const precipChance  = Math.round((todayForecast.precipProbability || 0) * 100)
  const cityName      = userLocation.city || 'Your area'

  const briefingBody = cityName + ' · ' + currentTemp + '° · ' + conditions + '\n'
    + 'High ' + highTemp + '°, low ' + lowTemp + '°'
    + (precipChance > 0 ? ' · ' + precipChance + '% chance of rain.' : '.')

  new Notification({
    title: APP_NAME + 'Good Morning! ☀️',
    body:  briefingBody,
    icon:  APP_ICON,
  }).show()

  lastMorningBriefingDate = todayDateString
}


// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('toggle-expand', function() {
  // The compact pill is gone — "closing" the panel just hides the whole window
  mainWindow.hide()
})

ipcMain.on('refresh', function() {
  fetchWeatherData()
})


// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(function() {

  // Set the dock icon before hiding — macOS pulls the notification icon from here
  if (process.platform === 'darwin') {
    app.dock.setIcon(APP_ICON)
    app.dock.hide()
  }

  // Serve local files via asset:// protocol
  // Maps  asset://renderer/Windy.gif  →  <project root>/renderer/Windy.gif
  protocol.handle('asset', async function(request) {
    const requestUrl  = new URL(request.url)
    const folderName  = requestUrl.hostname
    const filePath    = requestUrl.pathname
    const fullPath    = join(currentDirectory, folderName, filePath)

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
  createTray()

  // Wait for renderer to finish loading before sending any IPC messages
  mainWindow.webContents.once('did-finish-load', resolveUserLocation)

  // Poll every 10 minutes — setInterval handles mac sleep cleanly
  // (node-cron fires missed executions in a flood after waking from sleep)
  setInterval(fetchWeatherData, POLL_INTERVAL_MS)
})

app.on('window-all-closed', function() {
  // Do nothing — this is a tray app that stays alive in the menu bar.
  // The user quits via the right-click context menu on the tray icon.
})

app.on('activate', function() {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
