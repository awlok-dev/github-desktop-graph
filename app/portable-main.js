// Configure portable storage before any application module initializes state.
const { app, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const dataPath =
  app.commandLine.getSwitchValue('user-data-dir') ||
  path.join(path.dirname(process.execPath), 'Data')
try {
  fs.mkdirSync(dataPath, { recursive: true })
  fs.accessSync(dataPath, fs.constants.W_OK)
  const sessionPath = path.join(dataPath, 'Session')
  fs.mkdirSync(sessionPath, { recursive: true })
  app.setName('GitHub Desktop Graph')
  app.setPath('userData', dataPath)
  app.setPath('sessionData', sessionPath)
  app.setAppLogsPath(path.join(dataPath, 'logs'))
  app.setAppUserModelId('com.awlok.GitHubDesktopGraph.Portable')
} catch (error) {
  dialog.showErrorBox(
    'Cannot open GitHub Desktop Graph',
    'Extract the entire ZIP into a folder you can write to, such as Documents, ' +
      'then open GitHubDesktopGraph.exe.\n\n' +
      String(error)
  )
  app.exit(1)
  return
}
require('./main.js')
