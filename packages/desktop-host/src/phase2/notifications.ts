export type NotificationKind = 'task-completed' | 'task-failed' | 'approval-needed' | 'question-needed'

export interface DesktopNotification {
  kind: NotificationKind
  title: string
  body: string
  createdAt: string
}

export interface NotificationPolicy {
  enabled: boolean
  kinds: Record<NotificationKind, boolean>
}

export const DEFAULT_NOTIFICATION_POLICY: Readonly<NotificationPolicy> = Object.freeze({
  enabled: true,
  kinds: Object.freeze({
    'task-completed': true,
    'task-failed': true,
    'approval-needed': true,
    'question-needed': true,
  }),
})

export function createDesktopNotification(kind: NotificationKind, title: string, body: string): DesktopNotification {
  if (title.trim() === '') throw new Error('notification title is required')
  if (body.trim() === '') throw new Error('notification body is required')
  return { kind, title: title.trim().slice(0, 160), body: body.trim().slice(0, 4_000), createdAt: new Date().toISOString() }
}

export function shouldNotify(notification: DesktopNotification, policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY): boolean {
  return policy.enabled && policy.kinds[notification.kind] === true
}
