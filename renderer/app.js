// ─────────────────────────────────────────────────────────────────────────────
// app.js — Renderer
//
// Responsibilities:
//   - Receive weather data from main via IPC and update the UI
//   - Compute a weather state (rain_coming, sunset, etc.) to drive the media slot
//   - Render hourly and daily forecast strips
//   - Handle compact ↔ expanded toggle interactions
// ─────────────────────────────────────────────────────────────────────────────


// ── Weather icon characters (weathericons font) ───────────────────────────────
// Font is loaded in index.html via @font-face from node_modules/weathericons

const WEATHER_ICON_CHARACTERS = {
  'clear-day':           '\uf00d',
  'clear-night':         '\uf02e',
  'rain':                '\uf019',
  'drizzle':             '\uf01a',
  'snow':                '\uf01b',
  'sleet':               '\uf0b5',
  'wind':                '\uf021',
  'fog':                 '\uf014',
  'cloudy':              '\uf013',
  'overcast':            '\uf013',
  'partly-cloudy-day':   '\uf002',
  'partly-cloudy-night': '\uf031',
  'hail':                '\uf015',
  'thunderstorm':        '\uf01e',
  'tornado':             '\uf056',
}


// ── Media slot — weather state → gif or video ─────────────────────────────────
// The weather state is computed by getWeatherState() below.
// To add a new gif: drop the file into renderer/, then add or uncomment a line.
// All asset:// paths are resolved by the protocol handler in main.js.

const WEATHER_MEDIA_MAP = {
  // Rain states
  rain_coming:   { elementTag: 'img', filePath: 'asset://renderer/RainInYourArea.gif' },
  rain_active:   { elementTag: 'img', filePath: 'asset://renderer/Raining.gif'        },
  rain_stopping: { elementTag: 'img', filePath: 'asset://renderer/RainStopping.gif'   },
  rain:          { elementTag: 'img', filePath: 'asset://renderer/Raining.gif'        },

  // Time-of-day states
  morning:       { elementTag: 'img', filePath: 'asset://renderer/Wakeup.gif'         },
  sunrise:       { elementTag: 'img', filePath: 'asset://renderer/Sunrise.gif'        },
  sunset:        { elementTag: 'img', filePath: 'asset://renderer/Sunset.gif'         },

  // General conditions (matched against the API's icon name)
  'clear-day':   { elementTag: 'img', filePath: 'asset://renderer/Sunnyday1.gif'      },
  uv_warning:    { elementTag: 'img', filePath: 'asset://renderer/UVWarning.gif'      },
  hot:           { elementTag: 'img', filePath: 'asset://renderer/HotDay.gif'         },
  cloudy:        { elementTag: 'img', filePath: 'asset://renderer/PartlyCloudyday.gif' },
  overcast:      { elementTag: 'img', filePath: 'asset://renderer/PartlyCloudyday.gif' },
  snow:          { elementTag: 'img', filePath: 'asset://renderer/Snow.gif'           },
  thunderstorm:  { elementTag: 'img', filePath: 'asset://renderer/Thunderstorms.gif'  },
  wind:          { elementTag: 'img', filePath: 'asset://renderer/Windy.gif'          },
  tornado:       { elementTag: 'img', filePath: 'asset://renderer/Windy.gif'          },

  'clear-night':         { elementTag: 'img', filePath: 'asset://renderer/ClearNight.gif'      },
  'partly-cloudy-day':   { elementTag: 'img', filePath: 'asset://renderer/PartlyCloudyday.gif' },
  'partly-cloudy-night': { elementTag: 'img', filePath: 'asset://renderer/CloudyNight.gif'     },
  fog:                   { elementTag: 'img', filePath: 'asset://renderer/fog.gif'             },
  drizzle:               { elementTag: 'img', filePath: 'asset://renderer/drizzle.gif'         },
  hail:                  { elementTag: 'img', filePath: 'asset://renderer/Snow.gif'            },
  sleet:                 { elementTag: 'img', filePath: 'asset://renderer/Snow.gif'            },
}

// Determines which key to look up in WEATHER_MEDIA_MAP.
// Priority: rain → sunrise/sunset windows → morning → hot → API icon name
function getWeatherState(fullWeatherData) {
  const currentConditions = fullWeatherData.currently
  const currentTimestamp  = currentConditions.time
  const currentHour       = new Date(currentTimestamp * 1000).getHours()

  // Pull hourly items safely — the API may not always include them
  let hourlyItems = []
  if (fullWeatherData.hourly && fullWeatherData.hourly.data) {
    hourlyItems = fullWeatherData.hourly.data
  }

  const nextThreeHours = hourlyItems.slice(0, 3)

  // Pull today's daily data safely
  let todayData = null
  if (fullWeatherData.daily && fullWeatherData.daily.data && fullWeatherData.daily.data[0]) {
    todayData = fullWeatherData.daily.data[0]
  }

  // ── Rain checks ───────────────────────────────────────────────────────────
  const precipIntensity = currentConditions.precipIntensity || 0
  const isRainingNow    = precipIntensity > 0.1

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

  if (isRainComing)   { return 'rain_coming' }
  if (isRainStopping) { return 'rain_stopping' }
  if (isRainingNow)   { return 'rain_active' }

  // ── Actual sunrise event (60 min before sunrise) → Wakeup.gif ───────────
  let sunriseTime = null
  if (todayData) {
    sunriseTime = todayData.sunriseTime
  }

  let secondsUntilSunrise = -1
  if (sunriseTime) {
    secondsUntilSunrise = sunriseTime - currentTimestamp
  }

  if (secondsUntilSunrise >= 0 && secondsUntilSunrise <= 3600) { return 'morning' }

  // ── General morning window (5 AM – 9 AM) → Sunrise.gif ───────────────────
  if (currentHour >= 5 && currentHour < 9) { return 'sunrise' }

  // ── Sunset window (60 minutes before sunset) → Sunset.gif ────────────────
  let sunsetTime = null
  if (todayData) {
    sunsetTime = todayData.sunsetTime
  }

  let secondsUntilSunset = -1
  if (sunsetTime) {
    secondsUntilSunset = sunsetTime - currentTimestamp
  }

  if (secondsUntilSunset >= 0 && secondsUntilSunset <= 3600) { return 'sunset' }

  // ── High UV (UVI 8+, "Very High" or above) ───────────────────────────────
  const uvIndex = currentConditions.uvIndex || 0
  if (uvIndex >= 8) { return 'uv_warning' }

  // ── Hot day (feels like over 95°F) ────────────────────────────────────────
  const apparentTemperature = currentConditions.apparentTemperature || 0
  if (apparentTemperature >= 95) { return 'hot' }

  // ── Default: use the API's icon name directly (cloudy, snow, thunderstorm…)
  return currentConditions.icon
}


// ── Utility functions ─────────────────────────────────────────────────────────

function formatTimestamp(unixTimestamp) {
  return new Date(unixTimestamp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDayOfWeek(unixTimestamp) {
  return new Date(unixTimestamp * 1000).toLocaleDateString([], { weekday: 'short' })
}

function degreesToCompassDirection(degrees) {
  const compassDirections = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  const index = Math.floor((degrees || 0) / 22.5 + 0.5) % 16
  return compassDirections[index]
}

function getAqiLabel(ozoneValue) {
  const roundedOzone = Math.round(ozoneValue || 300)
  if (roundedOzone > 299) { return 'Good' }
  if (roundedOzone > 220) { return 'Moderate' }
  return 'Unhealthy'
}

function getUviLabel(uviValue) {
  const uvi = uviValue || 0
  if (uvi < 3)  { return 'Low' }
  if (uvi < 6)  { return 'Moderate' }
  if (uvi < 8)  { return 'High' }
  if (uvi < 11) { return 'Very High' }
  return 'Extreme'
}

function buildWindString(currentConditions) {
  const compassDirection = degreesToCompassDirection(currentConditions.windBearing)
  const windSpeed        = Math.round(currentConditions.windSpeed)
  const gustSpeed        = currentConditions.windGust || 0

  if (gustSpeed > currentConditions.windSpeed) {
    return compassDirection + ' ' + windSpeed + ' – ' + Math.round(gustSpeed) + ' mph'
  }
  return compassDirection + ' ' + windSpeed + ' mph'
}


// ── DOM element references ────────────────────────────────────────────────────

// Compact pill
const compactIconElement    = document.getElementById('compact-icon')
const compactTempElement    = document.getElementById('compact-temp')
const compactSummaryElement = document.getElementById('compact-summary')

// Expanded panel — header
const expandedPanelElement  = document.getElementById('expanded')
const locationElement       = document.getElementById('location')
const lastUpdateElement     = document.getElementById('last-update')

// Expanded panel — current conditions
const expandedIconElement       = document.getElementById('exp-icon')
const expandedTempElement       = document.getElementById('exp-temp')
const expandedConditionsElement = document.getElementById('exp-conditions')
const expandedStoryElement      = document.getElementById('exp-story')
const mediaSlotElement          = document.getElementById('media-slot')

// Expanded panel — detail fields
const feelsLikeElement   = document.getElementById('d-feels')
const humidityElement    = document.getElementById('d-humidity')
const windElement        = document.getElementById('d-wind')
const dewPointElement    = document.getElementById('d-dew')
const visibilityElement  = document.getElementById('d-vis')
const aqiElement         = document.getElementById('d-aqi')
const uviElement         = document.getElementById('d-uvi')

// Forecast
const forecastListElement = document.getElementById('forecast-list')
const hourlyButtonElement = document.getElementById('btn-hourly')
const dailyButtonElement  = document.getElementById('btn-daily')


// ── App state ─────────────────────────────────────────────────────────────────

let isExpanded          = false
let currentWeatherData  = null
let activeForecastMode  = 'hourly'
let activeAlertURL      = ''


// ── Render functions ──────────────────────────────────────────────────────────

function renderWeatherData(fullWeatherData) {
  currentWeatherData = fullWeatherData
  const currentConditions = fullWeatherData.currently

  // Compact pill
  compactIconElement.textContent    = WEATHER_ICON_CHARACTERS[currentConditions.icon] || '?'
  compactTempElement.textContent    = Math.round(currentConditions.temperature) + '°'
  compactSummaryElement.textContent = currentConditions.summary || ''

  // Expanded header
  lastUpdateElement.textContent     = 'Updated ' + formatTimestamp(currentConditions.time)
  expandedIconElement.textContent   = WEATHER_ICON_CHARACTERS[currentConditions.icon] || '?'
  expandedTempElement.textContent   = Math.round(currentConditions.temperature) + '°'
  expandedConditionsElement.textContent = currentConditions.summary || ''

  // Alert banner — shows weather alert title if one exists, otherwise hourly summary
  let firstAlert = null
  if (fullWeatherData.alerts && fullWeatherData.alerts[0]) {
    firstAlert = fullWeatherData.alerts[0]
  }

  if (firstAlert) {
    expandedStoryElement.textContent = '⚠️ ' + firstAlert.title
    expandedStoryElement.classList.add('warning')

    if (firstAlert.uri) {
      activeAlertURL = firstAlert.uri
    } else {
      activeAlertURL = ''
    }
  } else {
    let storySummary = ''
    if (fullWeatherData.hourly && fullWeatherData.hourly.summary) {
      storySummary = fullWeatherData.hourly.summary
    } else if (currentConditions.summary) {
      storySummary = currentConditions.summary
    }
    expandedStoryElement.textContent = storySummary
    expandedStoryElement.classList.remove('warning')
    activeAlertURL = ''
  }

  // Detail fields — row 1
  feelsLikeElement.textContent = Math.round(currentConditions.apparentTemperature) + '°'
  humidityElement.textContent  = Math.round(currentConditions.humidity * 100) + '%'
  windElement.textContent      = buildWindString(currentConditions)

  // Detail fields — row 2
  dewPointElement.textContent  = Math.round(currentConditions.dewPoint) + '°'
  visibilityElement.textContent = Math.round(currentConditions.visibility) + ' mi'
  aqiElement.textContent       = getAqiLabel(currentConditions.ozone)
  uviElement.textContent       = getUviLabel(currentConditions.uvIndex)

  updateMediaSlot(getWeatherState(fullWeatherData))
  renderForecast(activeForecastMode)
}

function updateMediaSlot(weatherStateKey) {
  const mediaEntry = WEATHER_MEDIA_MAP[weatherStateKey]
  if (!mediaEntry) {
    mediaSlotElement.innerHTML = ''
    return
  }
  if (mediaEntry.elementTag === 'video') {
    mediaSlotElement.innerHTML = '<video src="' + mediaEntry.filePath + '" autoplay loop muted playsinline></video>'
  } else {
    mediaSlotElement.innerHTML = '<img src="' + mediaEntry.filePath + '" alt="' + weatherStateKey + '">'
  }
}

function renderForecast(forecastMode) {
  if (!currentWeatherData) { return }
  forecastListElement.innerHTML = ''

  let forecastItems = []
  if (forecastMode === 'hourly') {
    if (currentWeatherData.hourly && currentWeatherData.hourly.data) {
      forecastItems = currentWeatherData.hourly.data.slice(0, 24)
    }
  } else {
    if (currentWeatherData.daily && currentWeatherData.daily.data) {
      forecastItems = currentWeatherData.daily.data
    }
  }

  for (let index = 0; index < forecastItems.length; index++) {
    const forecastItem = forecastItems[index]

    const containerElement        = document.createElement('div')
    containerElement.className    = 'forecast-item'

    const iconElement             = document.createElement('span')
    iconElement.className         = 'forecast-icon wi'
    iconElement.textContent       = WEATHER_ICON_CHARACTERS[forecastItem.icon] || '\uf07b'

    const timeElement   = document.createElement('div')
    timeElement.className = 'forecast-time'
    if (forecastMode === 'hourly') {
      timeElement.textContent = formatTimestamp(forecastItem.time)
    } else {
      timeElement.textContent = formatDayOfWeek(forecastItem.time)
    }

    const precipElement       = document.createElement('div')
    precipElement.className   = 'forecast-precip'
    precipElement.textContent = Math.round((forecastItem.precipProbability || 0) * 100) + '%'

    const temperatureElement = document.createElement('div')
    if (forecastMode === 'hourly') {
      temperatureElement.className  = 'forecast-temp'
      temperatureElement.textContent = Math.round(forecastItem.temperature) + '°'
    } else {
      temperatureElement.className  = 'forecast-lohi'
      temperatureElement.textContent = Math.round(forecastItem.temperatureLow) + '° | ' + Math.round(forecastItem.temperatureHigh) + '°'
    }

    containerElement.appendChild(iconElement)
    containerElement.appendChild(timeElement)
    containerElement.appendChild(precipElement)
    containerElement.appendChild(temperatureElement)
    forecastListElement.appendChild(containerElement)
  }
}


// ── IPC listeners ─────────────────────────────────────────────────────────────

window.electronAPI.onWeatherUpdate(function(fullWeatherData) {
  renderWeatherData(fullWeatherData)
})

window.electronAPI.onWeatherError(function(errorMessage) {
  compactSummaryElement.textContent = errorMessage
})

window.electronAPI.onLocationName(function(locationData) {
  const cityName   = locationData.city   || ''
  const regionName = locationData.region || ''

  const parts = []
  if (cityName.length > 0)   { parts.push(cityName) }
  if (regionName.length > 0) { parts.push(regionName) }

  if (parts.length > 0) {
    locationElement.textContent = parts.join(', ')
  } else {
    locationElement.textContent = '--'
  }
})

window.electronAPI.onExpandedChange(function(expandedState) {
  isExpanded = expandedState
  if (expandedState) {
    expandedPanelElement.classList.add('visible')
  } else {
    expandedPanelElement.classList.remove('visible')
  }
})


// ── UI interactions ───────────────────────────────────────────────────────────

// Click outside the expanded panel — close the window
document.addEventListener('click', function(clickEvent) {
  if (isExpanded && !expandedPanelElement.contains(clickEvent.target)) {
    window.electronAPI.toggleExpand()
  }
})

// Esc key — collapse
document.addEventListener('keydown', function(keyboardEvent) {
  if (keyboardEvent.key === 'Escape' && isExpanded) {
    window.electronAPI.toggleExpand()
  }
})

// Alert text — open the alert URL in the default browser
expandedStoryElement.addEventListener('click', function() {
  if (activeAlertURL) {
    window.open(activeAlertURL, '_blank')
  }
})

// Last-updated timestamp — manual refresh
lastUpdateElement.addEventListener('click', function(clickEvent) {
  clickEvent.stopPropagation()
  window.electronAPI.refresh()
})

// Hourly forecast toggle
hourlyButtonElement.addEventListener('click', function(clickEvent) {
  clickEvent.stopPropagation()
  activeForecastMode = 'hourly'
  hourlyButtonElement.classList.add('active')
  dailyButtonElement.classList.remove('active')
  renderForecast('hourly')
})

// Daily forecast toggle
dailyButtonElement.addEventListener('click', function(clickEvent) {
  clickEvent.stopPropagation()
  activeForecastMode = 'daily'
  dailyButtonElement.classList.add('active')
  hourlyButtonElement.classList.remove('active')
  renderForecast('daily')
})
