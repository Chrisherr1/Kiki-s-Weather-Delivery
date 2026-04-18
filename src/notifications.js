import { Notification } from 'electron'


// This file contains functions for firing notifications based on rain estimates
export function fireRainNotifications(rainStates, rainState, appIcon, appName) {
  if (rainStates.active   && !rainState.active) {
    new Notification({
      icon: appIcon,
      title: appName,
      body: '🌧 It\'s raining now.' }).show()
  }
  if (rainStates.coming   && !rainState.coming) {
    new Notification({
      icon: appIcon,
      title: appName,
      body: '🌂 Rain on the way in the next hour.' }).show()
  }
  if (rainStates.stopping && !rainState.stopping) {
    new Notification({
      icon: appIcon,
      title: appName,
      body: '🌤 Rain is clearing up soon.' }).show()
  }

  // gives us a way to track the last state so we only fire notifications on changes
  rainState.active   = rainStates.active
  rainState.coming   = rainStates.coming
  rainState.stopping = rainStates.stopping
}


// Fires notifications based on wind conditions and thresholds.
export function fireWindNotifications(currentConditions, windState, breezyMph, windyMph, appIcon, appName) {
  const windSpeed = currentConditions.windSpeed || 0
  const isWindy   = windSpeed >= windyMph
  const isBreezy  = windSpeed >= breezyMph && !isWindy

  if (isWindy && !windState.windy) {
    new Notification({
      icon: appIcon,
      title: appName,
      body: '💨 It\'s windy out — ' + Math.round(windSpeed) + ' mph.' }).show()
  } else if (isBreezy && !windState.breezy && !windState.windy) {
    new Notification({
      icon: appIcon,
      title: appName,
      body: '🍃 Getting breezy — ' + Math.round(windSpeed) + ' mph.' }).show()
  }

  if (!isWindy && !isBreezy && windState.windy) {
    new Notification({
      icon: appIcon,
      title: appName,
      body: '😌 Wind has calmed down.' }).show()
  }

  // allows us to track the last state so we only fire notifications on changes
  windState.windy  = isWindy
  windState.breezy = isBreezy
}


// Fires a morning briefing notification with the day's forecast and current conditions.
export function fireMorningBriefing(weatherData, userLocation, morningState, appIcon, appName) {

  const currentHour = new Date().getHours()
  if (currentHour < 6 || currentHour >= 9) { return }

  // todayDateString gives us a simple way to track if we've already fired a briefing today, since we only want to fire one per day
  const todayDateString = new Date().toDateString()

  // if we've already fired a briefing today, don't fire another one
  if (morningState.lastDate === todayDateString) {
    return;
  }
  
  const currentConditions = weatherData.currently
  const todayForecast     = weatherData.daily && weatherData.daily.data && weatherData.daily.data[0]

  // if we don't have the data we need, don't fire anything
  if (!todayForecast) { 
    return;
  }


  // build out the notification body with the data we have
  const currentTemp  = Math.round(currentConditions.temperature)
  const conditions   = currentConditions.summary || ''
  const highTemp     = Math.round(todayForecast.temperatureHigh)
  const lowTemp      = Math.round(todayForecast.temperatureLow)
  const precipChance = Math.round((todayForecast.precipProbability || 0) * 100)
  const cityName     = userLocation.city || 'Your area'


  // Example: "San Francisco · 65° · Partly Cloudy. High 68°, low 55°, 20% chance of rain."
  const briefingBody = cityName + ' · ' + currentTemp + '° · ' + conditions + '\n'
    + 'High ' + highTemp + '°, low ' + lowTemp + '°'
    + (precipChance > 0 ? ' · ' + precipChance + '% chance of rain.' : '.')

  // Fire the notification
  new Notification({
    title: appName + '— Good Morning! ☀️',
    body:  briefingBody,
    icon:  appIcon,
  }).show()

  morningState.lastDate = todayDateString
}


// Fires a notification when a thunderstorm moves in, only on transition
export function fireThunderstormNotification(currentConditions, stormState, appIcon, appName) {
  const isThunderstormNow = currentConditions.icon === 'thunderstorm'

  if (isThunderstormNow && !stormState.active) {
    new Notification({
      icon:  appIcon,
      title: appName,
      body:  '⛈ Thunderstorm in your area. Stay safe.',
    }).show()
  }

  stormState.active = isThunderstormNow
}


// Fires a notification when UV index hits Very High (8+), only on transition
export function fireUVWarningNotification(currentConditions, uvState, appIcon, appName) {
  const uvIndex       = currentConditions.uvIndex || 0
  const isHighUVNow   = uvIndex >= 8

  if (isHighUVNow && !uvState.active) {
    new Notification({
      icon:  appIcon,
      title: appName,
      body:  '🌞 Very high UV today (' + uvIndex + '). Consider sunscreen if heading outside.',
    }).show()
  }

  uvState.active = isHighUVNow
}
