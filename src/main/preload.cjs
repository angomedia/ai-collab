const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('council', Object.freeze({
  platform: process.platform,
  getState: () => ipcRenderer.invoke('council:state'),
  savePreferences: input => ipcRenderer.invoke('council:preferences-save', input),
  refreshProviders: () => ipcRenderer.invoke('council:providers'),
  getModels: force => ipcRenderer.invoke('council:models', force),
  pickAttachments: () => ipcRenderer.invoke('council:attachments-pick'),
  removeAttachment: id => ipcRenderer.invoke('council:attachment-remove', id),
  reuseAttachments: id => ipcRenderer.invoke('council:attachments-reuse', id),
  startRun: input => ipcRenderer.invoke('council:start', input),
  followUp: (id, input) => ipcRenderer.invoke('council:follow-up', id, input),
  stopRun: id => ipcRenderer.invoke('council:stop', id),
  exportRun: id => ipcRenderer.invoke('council:export', id),
  copyText: text => ipcRenderer.invoke('council:copy', text),
  signIn: provider => ipcRenderer.invoke('council:sign-in', provider),
  setupProvider: (provider, action) => ipcRenderer.invoke('council:setup-provider', provider, action),
  chooseProviderExecutable: provider => ipcRenderer.invoke('council:choose-executable', provider),
  clearProviderExecutable: provider => ipcRenderer.invoke('council:clear-executable', provider),
  openLink: url => ipcRenderer.invoke('council:open-link', url),
  onRunUpdate: callback => subscribe('council:run-updated', callback),
  onProviders: callback => subscribe('council:providers-updated', callback),
}));
