import { Tray, Menu, screen, app } from 'electron'


/*  tray.js
    This file basically just makes the tray icon and handles positioning the main window when it's shown, 
    including some adjustments to account for differences in how the taskbar works on windows vs mac.
*/

// gives the position for the main window to appear below the tray icon, with some adjustments to keep it on screen and account for differences in how the taskbar works on windows vs mac
export function getPositionBelowTray(trayBounds, windowWidth, windowHeight) {
  const primaryDisplay = screen.getPrimaryDisplay()
  const displayBounds  = primaryDisplay.bounds

  if (process.platform === 'win32') {
    const workArea = primaryDisplay.workAreaSize
    const windowX  = Math.round(trayBounds.x + trayBounds.width / 2 - windowWidth / 2)
    const windowY  = workArea.height - windowHeight - 4
    return {
      x: Math.max(8, Math.min(windowX, displayBounds.width - windowWidth - 8)),
      y: windowY,
    }
  }
  const windowX = displayBounds.width - windowWidth - 8
  const windowY = trayBounds.y + trayBounds.height + 4
  return {
    x: Math.max(8, Math.min(windowX, displayBounds.width - windowWidth - 8)),
    y: windowY,
  }
}

// Creates a tray icon for the pc and sets up click and right-click handlers for showing the main window and context menu.
export function createTray(mainWindow, appIcon, appName, expandedWidth, expandedHeight, onRefresh) {
  const tray = new Tray(appIcon)
  tray.setToolTip(appName + ' — click to open')

  tray.on('click', function(clickEvent, trayBounds) {
    if (mainWindow.isVisible()) {
      mainWindow.hide()
      return
    }

    const windowPosition = getPositionBelowTray(trayBounds, expandedWidth, expandedHeight)
    mainWindow.setBounds({
      x:      windowPosition.x,
      y:      windowPosition.y,
      width:  expandedWidth,
      height: expandedHeight,
    })
    mainWindow.webContents.send('expanded-change', true)
    mainWindow.show()
    mainWindow.focus()
  })

  tray.on('right-click', function() {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Refresh Weather', click: onRefresh },
      { type: 'separator' },
      { label: 'Quit', click: function() { app.quit() } },
    ])
    tray.popUpContextMenu(contextMenu)
  })

  return tray
}
