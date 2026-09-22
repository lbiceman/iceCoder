export {};

/** Electron preload 注入；未注入时为 undefined。 */
interface IceDesktopApi {
  notifyTaskDone?: (payload: unknown) => void;
  onTaskDoneNotifyClick?: (handler: (sessionId: string) => void) => void;
  _iceTaskDoneNotifyClickBound?: boolean;
  petPushState?: (snapshot: unknown) => void;
  onPetForceVisible?: (handler: (visible: boolean) => void) => void;
  petSetMousePassthrough?: (passthrough: boolean) => void;
  [key: string]: unknown;
}

interface IceUiNotify {
  notify?: (message: string, type?: string, opts?: unknown) => unknown;
  [key: string]: unknown;
}

declare global {
  interface Window {
    iceDesktop?: IceDesktopApi;
    UI?: IceUiNotify;
    AppIcon?: any;
    Notification?: any;
    Modal?: any;
    DiffViewer?: any;
    EtlPrefs?: any;
    ModelNames?: any;
    ToolTraceFormat?: any;
    ToolDisplayHistory?: any;
    ModelConfigPanel?: any;
    McpConfigPanel?: any;
    SupervisorConfigPanel?: any;
    SettingsPage?: any;
    ConfigPage?: any;
    SessionPet?: any;
    SESSION_PET_DISPLAY_NAME?: string;
    IceSupervisorModeEyeColor?: any;
    DesktopPetBridge?: any;
    ChatWebSocket?: any;
    ChatSession?: any;
    ChatSessionStore?: any;
    ChatSessionSidebar?: any;
    ChatUI?: any;
    ChatImagePreview?: any;
    ChatWelcome?: any;
    ChatDropdown?: any;
    ChatCommands?: any;
    ChatModelPicker?: any;
    ChatReasoningStepper?: any;
    ChatFile?: any;
    ChatQR?: any;
    ChatPetBridge?: any;
    EtlShellDock?: any;
    EtlChronicle?: any;
    ChatExecutionPlan?: any;
    ChatExecutionFlowStore?: any;
    ChatExecutionPlanBridge?: any;
    ChatVirtualHistory?: any;
    ChatStaircaseNav?: any;
    BgTaskChip?: any;
    ChatSkills?: any;
    ChatFileRef?: any;
    MobileSessionDrawer?: any;
    MobileComposerHost?: any;
    MobileShell?: any;
    MobileWorkPage?: any;
    MobileChatPage?: any;
    MobileMemoryPage?: any;
    MobileSkillsPage?: any;
    MobileConfigPage?: any;
    ChatTaskQueue?: any;
    ChatShellDock?: any;
    ChatWsStreamHandlers?: any;
    ChatWsSessionHandlers?: any;
    ChatWsRestoreHandlers?: any;
    ChatWsBgTaskHandlers?: any;
    ChatPage?: any;
    MemoryPage?: any;
    SkillsPage?: any;
    StatsPage?: any;
    AppShell?: any;
    AppRouter?: any;
    [key: string]: any;
  }
}
