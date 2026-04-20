-- Reverse of task-019-D notification preferences table.
DROP INDEX IF EXISTS "UserNotificationPreference_user_ws_idx";
DROP INDEX IF EXISTS "UserNotificationPreference_user_ev_idx";
DROP INDEX IF EXISTS "UserNotificationPreference_user_global_ev_uniq";
DROP INDEX IF EXISTS "UserNotificationPreference_user_ws_ev_uniq";
DROP TABLE IF EXISTS "UserNotificationPreference";
DROP TYPE IF EXISTS "NotificationChannel";
DROP TYPE IF EXISTS "NotificationEventType";
