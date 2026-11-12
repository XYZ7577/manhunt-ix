
DELETE FROM account_deletions;
DELETE FROM group_deletions;
DELETE FROM group_disband_challenges;

DELETE FROM caught_push_deliveries;
DELETE FROM caught_email_deliveries;
DELETE FROM caught_notification_events;
DELETE FROM game_guesses;
DELETE FROM game_event_config;
DELETE FROM game_player_states;

DELETE FROM review_email_deliveries;
DELETE FROM push_deliveries;
DELETE FROM announcement_push_deliveries;
DELETE FROM announcement_email_deliveries;
DELETE FROM announcement_recipients;
DELETE FROM announcements;
DELETE FROM notification_reads;
DELETE FROM push_subscriptions;
DELETE FROM review_notifications;

DELETE FROM account_approval_email_attempts;
DELETE FROM account_approvals;
DELETE FROM group_invitations;
DELETE FROM group_leaders;
DELETE FROM group_disbands;
DELETE FROM submission_settings;
DELETE FROM group_merging_settings;

DELETE FROM upload_parts;
DELETE FROM evidence_previews;
DELETE FROM evidence;
DELETE FROM upload_sessions;
DELETE FROM submissions;

DELETE FROM email_signin_challenges;
DELETE FROM email_verification_challenges;
DELETE FROM password_reset_challenges;
DELETE FROM totp_challenges;
DELETE FROM totp_recovery_codes;
DELETE FROM account_group_requests;
DELETE FROM account_contacts;
DELETE FROM account_emails;
DELETE FROM account_security;

DELETE FROM google_auth_flows;
DELETE FROM sms_auth_challenges;
DELETE FROM federated_identities;
DELETE FROM sessions;
DELETE FROM login_attempts;
DELETE FROM auth_rate_buckets;

DELETE FROM accounts;
DELETE FROM groups;

DELETE FROM sqlite_sequence WHERE name = 'review_notifications';
