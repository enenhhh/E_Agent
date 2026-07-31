import { Notification } from 'electron';

/**
 * 使用桌面原生通知展示非敏感任务状态。
 */
export class NotificationService {
  /**
   * 展示一条长度受限的原生通知。
   */
  public async show(title: string, body: string): Promise<void> {
    if (!Notification.isSupported()) {
      return;
    }
    new Notification({
      title: title.slice(0, 120),
      body: body.slice(0, 1_000),
      silent: false,
    }).show();
  }
}
