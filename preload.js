// ─────────────────────────────────────────────────────────────────────────────
// preload.js — IPC bridge
//
// Runs in the renderer's context before any renderer scripts, but with access
// to Node/Electron APIs. contextBridge exposes a minimal, safe API to the
// renderer — the full ipcRenderer object never leaks out.
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Main → Renderer (incoming data) ──────────────────────────────────────
  onWeatherUpdate:  function(callback) { ipcRenderer.on('weather-update',  function(event, data)            { callback(data)     }) },
  onWeatherError:   function(callback) { ipcRenderer.on('weather-error',   function(event, errorMessage)    { callback(errorMessage) }) },
  onLocationName:   function(callback) { ipcRenderer.on('location-name',   function(event, locationData)    { callback(locationData)  }) },
  onExpandedChange: function(callback) { ipcRenderer.on('expanded-change', function(event, isExpanded)      { callback(isExpanded)    }) },

  // ── Renderer → Main (outgoing actions) ───────────────────────────────────
  toggleExpand: function() { ipcRenderer.send('toggle-expand') },
  refresh:      function() { ipcRenderer.send('refresh')       },
})
