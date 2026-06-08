/**
 * menu.ts — 应用菜单
 */
import { app, dialog, Menu, MenuItemConstructorOptions, shell, BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { IPC } from './constants';

export interface MenuCallbacks {
  pickWorkspace: () => Promise<string | null>;
  openDataDir: () => void;
  openDevTools: () => void;
  quit: () => void;
}

export function buildAppMenu(cb: MenuCallbacks): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: '文件(&F)',
      submenu: [
        {
          label: '打开文件夹…',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void cb.pickWorkspace(); },
        },
        {
          label: '打开数据目录',
          click: () => cb.openDataDir(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { label: '退出', click: () => cb.quit() },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { role: 'reload' },
        { label: '开发者工具', accelerator: 'F12', click: () => cb.openDevTools() },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于 iceCoder',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于 iceCoder',
              message: 'iceCoder 桌面版',
              detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\nChrome: ${process.versions.chrome}`,
            });
          },
        },
        {
          label: '访问 GitHub',
          click: () => { void shell.openExternal('https://github.com/'); },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
