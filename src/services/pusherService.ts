import Pusher from 'pusher';
import { config } from '../config/env';

class PusherService {
  private pusher: Pusher | null = null;
  private isConfigured: boolean = false;

  constructor() {
    if (config.PUSHER_APP_ID && config.PUSHER_KEY && config.PUSHER_SECRET) {
      try {
        this.pusher = new Pusher({
          appId: config.PUSHER_APP_ID,
          key: config.PUSHER_KEY,
          secret: config.PUSHER_SECRET,
          cluster: config.PUSHER_CLUSTER || 'ap4',
          useTLS: true,
        });
        this.isConfigured = true;
      } catch (error) {
        console.warn('⚠️ Failed to initialize Pusher:', error);
      }
    } else {
      console.log('ℹ️ Pusher not configured, realtime sync updates disabled');
    }
  }

  public getOrgChannel(orgId: string): string {
    return `org-${orgId}`;
  }

  public async triggerEvent(channel: string, event: string, data: any): Promise<void> {
    if (!this.isConfigured || !this.pusher) {
      // #region agent log
      const fs = require('fs');
      const logPath = '/Users/valeshannaidoo/Desktop/Projects/nxt/.cursor/debug.log';
      fs.appendFileSync(logPath, JSON.stringify({location:'pusherService.ts:32',message:'Pusher not configured, skipping event',data:{channel,event,isConfigured:this.isConfigured,hasPusher:!!this.pusher},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})+'\n');
      // #endregion
      return;
    }

    try {
      // Ensure safe serialization if needed, but pusher handles JSON.
      // We make sure critical date fields are strings in the calling code, 
      // but it's good practice to ensure we don't throw here.
      await this.pusher.trigger(channel, event, data);
      // #region agent log
      const fs = require('fs');
      const logPath = '/Users/valeshannaidoo/Desktop/Projects/nxt/.cursor/debug.log';
      fs.appendFileSync(logPath, JSON.stringify({location:'pusherService.ts:40',message:'Pusher event triggered',data:{channel,event,invoiceFileId:data?.invoiceFileId,organisationId:data?.organisationId,status:data?.status},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})+'\n');
      // #endregion
    } catch (error: any) {
      // Soft fail - do not disrupt the main flow
      console.error(`⚠️ Failed to trigger Pusher event '${event}' on '${channel}':`, error.message);
      // #region agent log
      const fs = require('fs');
      const logPath = '/Users/valeshannaidoo/Desktop/Projects/nxt/.cursor/debug.log';
      fs.appendFileSync(logPath, JSON.stringify({location:'pusherService.ts:44',message:'Pusher event failed',data:{channel,event,error:error.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})+'\n');
      // #endregion
    }
  }
}

export const pusherService = new PusherService();








