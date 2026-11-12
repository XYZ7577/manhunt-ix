export const GAME_RESULT_ANNOUNCEMENT_ID = 'geoguessr-result';

export type AnnouncementStatus = 'scheduled' | 'published' | 'cancelled';
export type AnnouncementDeliveryStatusCounts = Record<'pending' | 'sent' | 'failed' | 'cancelled', number>;

export interface Announcement {
    id: string;
    title: string;
    message: string;
    status: AnnouncementStatus;
    scheduledFor: string;
    createdAt: string;
    publishedAt: string | null;
    cancelledAt: string | null;
    sendEmail: boolean;
    recipientCount: number;
    delivery?: { email: AnnouncementDeliveryStatusCounts; push: AnnouncementDeliveryStatusCounts };
}

export interface AnnouncementInbox {
    announcements: Array<Announcement & { read: boolean }>;
    unreadCount: number;
}
