export interface TuiConnectionStateOptions {
  disconnectGraceMs: number;
  log?: (msg: string) => void;
  onDisconnectPersisted: (connId: number) => void;
  onReconnectAfterNotice: (connId: number) => void;
}

export interface TuiConnectionSnapshot {
  bridgeReady: boolean;
  tuiConnected: boolean;
  disconnectNotificationShown: boolean;
  hasPendingDisconnectNotification: boolean;
}

export class TuiConnectionState {
  private bridgeReady = false;
  private tuiConnected = false;
  private disconnectNotificationShown = false;
  private disconnectNotificationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TuiConnectionStateOptions) {}

  canReply() {
    if (!this.bridgeReady) return false;
    // Allow replies during the grace window — TUI may reconnect shortly
    return this.tuiConnected || this.disconnectNotificationTimer !== null;
  }

  snapshot(): TuiConnectionSnapshot {
    return {
      bridgeReady: this.bridgeReady,
      tuiConnected: this.tuiConnected,
      disconnectNotificationShown: this.disconnectNotificationShown,
      hasPendingDisconnectNotification: this.disconnectNotificationTimer !== null,
    };
  }

  markBridgeReady() {
    this.bridgeReady = true;
    this.disconnectNotificationShown = false;
    this.clearPendingDisconnectNotification("thread became ready");
  }

  handleTuiConnected(connId: number) {
    const reconnectingAfterNotice = this.disconnectNotificationShown && this.bridgeReady;
    this.tuiConnected = true;
    this.clearPendingDisconnectNotification(`TUI reconnected as conn #${connId}`);

    if (reconnectingAfterNotice) {
      this.disconnectNotificationShown = false;
      this.options.onReconnectAfterNotice(connId);
    }
  }

  handleTuiDisconnected(connId: number) {
    this.tuiConnected = false;

    if (!this.bridgeReady) {
      this.options.log?.(`Suppressing pre-ready TUI disconnect notification (conn #${connId})`);
      return;
    }

    this.scheduleDisconnectNotification(connId);
  }

  handleCodexExit() {
    this.bridgeReady = false;
    this.tuiConnected = false;
    this.disconnectNotificationShown = false;
    this.clearPendingDisconnectNotification("Codex process exited");
  }

  dispose(reason = "disposed") {
    this.clearPendingDisconnectNotification(reason);
  }

  private clearPendingDisconnectNotification(reason?: string) {
    if (!this.disconnectNotificationTimer) return;
    clearTimeout(this.disconnectNotificationTimer);
    this.disconnectNotificationTimer = null;
    if (reason) {
      this.options.log?.(`Cleared pending TUI disconnect notification (${reason})`);
    }
  }

  private scheduleDisconnectNotification(connId: number) {
    this.clearPendingDisconnectNotification("rescheduled");
    this.disconnectNotificationTimer = setTimeout(() => {
      this.disconnectNotificationTimer = null;
      if (this.tuiConnected) {
        this.options.log?.(
          `Skipping TUI disconnect notification for conn #${connId} because TUI already reconnected`,
        );
        return;
      }

      this.disconnectNotificationShown = true;
      this.options.log?.(`Codex TUI disconnect persisted past grace window (conn #${connId})`);
      this.options.onDisconnectPersisted(connId);
    }, this.options.disconnectGraceMs);
  }
}
