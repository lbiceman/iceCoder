/**
 * menu.ts — 应用菜单
 */
import { app, dialog, Menu, MenuItemConstructorOptions, shell } from 'electron';

export interface MenuCallbacks {
  pickWorkspace: () => Promise<string | null>;
  openDataDir: () => void;
  openDevTools: () => void;
  quit: () => void;
}

export function buildAppMenu(_cb: MenuCallbacks): Menu {
  const template: MenuItemConstructorOptions[] = [
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
          click: () => { void shell.openExternal('https://github.com/lbiceman/iceCoder'); },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
