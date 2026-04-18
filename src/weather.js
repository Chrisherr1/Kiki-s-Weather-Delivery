import { fireRainNotifications, fireWindNotifications, fireMorningBriefing, fireThunderstormNotification, fireUVWarningNotification } from './notifications.js'

export function analyzeRainStates(currentConditions, hourlyDataArray) {
  const hourlyItems     = hourlyDataArray || []
  const precipIntensity = currentConditions.precipIntensity || 0
  const nextThreeHours  = hourlyItems.slice(0, 3)

  const isRainingNow = precipIntensity > 0.1

  // Rain is coming if it's not raining now but any of the next 3 hours show rain
  let isRainComing = false
  if (!isRainingNow) {
    for (let i = 0; i < nextThreeHours.length; i++) {
      const hourlyPrecip = nextThreeHours[i].precipIntensity || 0
      if (hourlyPrecip > 0.1) {
        isRainComing = true
        break
      }
    }
  }

  // Rain is stopping if it's raining now but the next 2+ hours show it clearing
  let isRainStopping = false

  if (isRainingNow) {
    const upcomingHours = nextThreeHours.slice(1)
    let allClearing = true
    for (let i = 0; i < upcomingHours.length; i++) {
      const hourlyPrecip = upcomingHours[i].precipIntensity || 0
      if (hourlyPrecip > 0.05) {
        allClearing = false
        break
      }
    }
    isRainStopping = allClearing
  }

  return {
    active:   isRainingNow && !isRainStopping,
    coming:   isRainComing,
    stopping: isRainStopping,
  }
}


export async function fetchWeatherData(mainWindow, tray, userLocation, rainState, windState, morningState, stormState, uvState, appIcon, appName, breezyMph, windyMph) {
  if (!userLocation.lat) {
    return;
  }

  const apiKey = process.env.PIRATE_WEATHER_KEY


  // Checks if API Key is missing
  if (!apiKey) {
    mainWindow.webContents.send('weather-error', 'Missing PIRATE_WEATHER_KEY in .env')
    return
  }
  // Does the fetch from Pirate Weather API using the user's location
  const apiUrl = 'https://api.pirateweather.net/forecast/'
    + apiKey + '/'
    + userLocation.lat + ',' + userLocation.lng
    + '?exclude=minutely,flags&units=us'

  try {

    // If the fetch fails, we catch it and send an error message to the renderer process to display to the user
    const response = await fetch(apiUrl)
    if (!response.ok) { throw new Error('HTTP ' + response.status) }

    // If the fetch succeeds, we parse the weather data and fire notifications as needed based on changes in rain and wind conditions, as well as the morning briefing. 
    // We also send the weather data to the renderer process for display in the UI, and update the tray icon title with the current temperature on macOS.
    const weatherData       = await response.json()
    const currentConditions = weatherData.currently

    // analyze the rain conditions to determine if we need to fire any notifications about rain starting, stopping, or coming soon
    const rainStates = analyzeRainStates(currentConditions, weatherData.hourly?.data)
    fireRainNotifications(rainStates, rainState, appIcon, appName)
    fireWindNotifications(currentConditions, windState, breezyMph, windyMph, appIcon, appName)
    fireThunderstormNotification(currentConditions, stormState, appIcon, appName)
    fireUVWarningNotification(currentConditions, uvState, appIcon, appName)
    fireMorningBriefing(weatherData, userLocation, morningState, appIcon, appName)

    // send the weather data to the renderer process for display in the UI
    mainWindow.webContents.send('weather-update', weatherData)
    console.log('[weather]', currentConditions.summary)
    
    if (tray && process.platform === 'darwin') {
      tray.setTitle(' ' + Math.round(currentConditions.temperature) + '°')
    }

    // on Windows, setTitle isn't supported so we update the tooltip with the temperature instead
    if (tray && process.platform === 'win32') {
      tray.setToolTip(appName + ' — ' + Math.round(currentConditions.temperature) + '° · ' + currentConditions.summary)
    }
  } catch (fetchError) {
    console.error('[weather] fetch failed:', fetchError.message)
    mainWindow.webContents.send('weather-error', 'Fetch failed: ' + fetchError.message)
  }
}
